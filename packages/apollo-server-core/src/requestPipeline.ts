import {
  GraphQLSchema,
  GraphQLFieldResolver,
  specifiedRules,
  DocumentNode,
  getOperationAST,
  ExecutionResult,
  GraphQLError,
} from 'graphql';
import * as graphql from 'graphql';
import {
  GraphQLExtension,
  GraphQLExtensionStack,
  enableGraphQLExtensions,
} from 'graphql-extensions';
import { DataSource } from 'apollo-datasource';
import { PersistedQueryOptions } from '.';
import {
  CacheControlExtension,
  CacheControlExtensionOptions,
} from 'apollo-cache-control';
import { TracingExtension } from 'apollo-tracing';
import {
  ApolloError,
  fromGraphQLError,
  SyntaxError,
  ValidationError,
  PersistedQueryNotSupportedError,
  PersistedQueryNotFoundError,
} from 'apollo-server-errors';
import { createHash } from 'crypto';
import {
  GraphQLRequest,
  GraphQLResponse,
  DeferredGraphQLResponse,
  GraphQLRequestContext,
  InvalidGraphQLRequestError,
  ValidationRule,
} from '../dist/requestPipelineAPI';
import {
  ApolloServerPlugin,
  GraphQLRequestListener,
  WithRequired,
} from 'apollo-server-plugin-base';

import { Dispatcher } from './utils/dispatcher';
import { CannotDeferNonNullableFields } from './validationRules/CannotDeferNonNullableFields';

export {
  GraphQLRequest,
  GraphQLResponse,
  DeferredGraphQLResponse,
  GraphQLRequestContext,
  InvalidGraphQLRequestError,
};

import {
  execute as executeWithDefer,
  ExecutionArgs,
  isDeferredExecutionResult,
  ExecutionPatchResult,
  DeferredExecutionResult,
} from './execute';

function computeQueryHash(query: string) {
  return createHash('sha256')
    .update(query)
    .digest('hex');
}

export function isDeferredGraphQLResponse(
  result: any,
): result is DeferredGraphQLResponse {
  return (
    (<DeferredGraphQLResponse>result).initialResponse !== undefined &&
    (<DeferredGraphQLResponse>result).deferredPatches !== undefined
  );
}

export interface GraphQLRequestPipelineConfig<TContext> {
  schema: GraphQLSchema;

  rootValue?: ((document: DocumentNode) => any) | any;
  validationRules?: ValidationRule[];
  fieldResolver?: GraphQLFieldResolver<any, TContext>;

  dataSources?: () => DataSources<TContext>;

  extensions?: Array<() => GraphQLExtension>;
  tracing?: boolean;
  persistedQueries?: PersistedQueryOptions;
  cacheControl?: CacheControlExtensionOptions;

  formatError?: Function;
  formatResponse?: Function;

  plugins?: ApolloServerPlugin[];
  enableDefer?: boolean;
}

export type DataSources<TContext> = {
  [name: string]: DataSource<TContext>;
};

type Mutable<T> = { -readonly [P in keyof T]: T[P] };

export async function processGraphQLRequest<TContext>(
  config: GraphQLRequestPipelineConfig<TContext>,
  requestContext: Mutable<GraphQLRequestContext<TContext>>,
): Promise<GraphQLResponse | DeferredGraphQLResponse> {
  let cacheControlExtension: CacheControlExtension | undefined;
  const extensionStack = initializeExtensionStack();
  (requestContext.context as any)._extensionStack = extensionStack;

  const dispatcher = initializeRequestListenerDispatcher();

  initializeDataSources();

  const request = requestContext.request;

  let { query, extensions } = request;

  let queryHash: string;

  let persistedQueryHit = false;
  let persistedQueryRegister = false;

  if (extensions && extensions.persistedQuery) {
    // It looks like we've received a persisted query. Check if we
    // support them.
    if (!config.persistedQueries || !config.persistedQueries.cache) {
      throw new PersistedQueryNotSupportedError();
    } else if (extensions.persistedQuery.version !== 1) {
      throw new InvalidGraphQLRequestError(
        'Unsupported persisted query version',
      );
    }

    queryHash = extensions.persistedQuery.sha256Hash;

    if (query === undefined) {
      query = await config.persistedQueries.cache.get(`apq:${queryHash}`);
      if (query) {
        persistedQueryHit = true;
      } else {
        throw new PersistedQueryNotFoundError();
      }
    } else {
      const computedQueryHash = computeQueryHash(query);

      if (queryHash !== computedQueryHash) {
        throw new InvalidGraphQLRequestError(
          'provided sha does not match query',
        );
      }

      persistedQueryRegister = true;

      Promise.resolve(
        config.persistedQueries.cache.set(`apq:${queryHash}`, query),
      ).catch(console.warn);
    }
  } else if (query) {
    // FIXME: We'll compute the APQ query hash to use as our cache key for
    // now, but this should be replaced with the new operation ID algorithm.
    queryHash = computeQueryHash(query);
  } else {
    throw new InvalidGraphQLRequestError('Must provide query string.');
  }

  requestContext.queryHash = queryHash;

  const requestDidEnd = extensionStack.requestDidStart({
    request: request.http!,
    queryString: request.query,
    operationName: request.operationName,
    variables: request.variables,
    extensions: request.extensions,
    persistedQueryHit,
    persistedQueryRegister,
    context: requestContext.context,
    requestContext,
  });

  const parsingDidEnd = await dispatcher.invokeDidStartHook(
    'parsingDidStart',
    requestContext,
  );

  let isDeferred = false;

  try {
    let document: DocumentNode;

    try {
      document = parse(query);
      parsingDidEnd();
    } catch (syntaxError) {
      parsingDidEnd(syntaxError);
      return sendErrorResponse(syntaxError, SyntaxError);
    }

    requestContext.document = document;

    const validationDidEnd = await dispatcher.invokeDidStartHook(
      'validationDidStart',
      requestContext as WithRequired<typeof requestContext, 'document'>,
    );

    const validationErrors = validate(document);

    if (validationErrors.length === 0) {
      validationDidEnd();
    } else {
      validationDidEnd(validationErrors);
      return sendErrorResponse(validationErrors, ValidationError);
    }

    // FIXME: If we want to guarantee an operation has been set when invoking
    // `willExecuteOperation` and executionDidStart`, we need to throw an
    // error here and not leave this to `buildExecutionContext` in
    // `graphql-js`.
    const operation = getOperationAST(document, request.operationName);

    requestContext.operation = operation || undefined;
    // We'll set `operationName` to `null` for anonymous operations.
    requestContext.operationName =
      (operation && operation.name && operation.name.value) || null;

    await dispatcher.invokeHookAsync(
      'didResolveOperation',
      requestContext as WithRequired<
        typeof requestContext,
        'document' | 'operation' | 'operationName'
      >,
    );

    const executionDidEnd = await dispatcher.invokeDidStartHook(
      'executionDidStart',
      requestContext as WithRequired<
        typeof requestContext,
        'document' | 'operation' | 'operationName'
      >,
    );

    let response: GraphQLResponse;
    let result: ExecutionResult | DeferredExecutionResult;
    let patches: AsyncIterable<ExecutionPatchResult> | undefined;
    let isDeferred = false;

    try {
      result = await execute(
        document,
        request.operationName,
        request.variables,
      );

      isDeferred = isDeferredExecutionResult(result);

      if (isDeferred) {
        response = (result as DeferredExecutionResult)
          .initialResult as GraphQLResponse;
        patches = (result as DeferredExecutionResult).deferredPatches;
      } else {
        response = result as GraphQLResponse;
      }

      const formattedExtensions = extensionStack.format();
      if (Object.keys(formattedExtensions).length > 0) {
        response.extensions = formattedExtensions;
      }

      // `formatResponse` format fallback for TS2722: Cannot invoke an object which is possibly 'undefined'.
      const formatResponse =
        config.formatResponse || ((x: GraphQLResponse): GraphQLResponse => x);

      response = formatResponse(response, {
        context: requestContext.context,
      });

      let output: GraphQLResponse | DeferredGraphQLResponse;

      if (isDeferred) {
        executionDidEnd();
        output = {
          initialResponse: response,
          deferredPatches: patches!,
          requestDidEnd,
          extensionStack,
        };
      } else {
        executionDidEnd();
        output = response;
      }

      return sendResponse(output);
    } catch (executionError) {
      executionDidEnd(executionError);
      return sendErrorResponse(executionError);
    }
  } finally {
    if (!isDeferred) {
      requestDidEnd();
    }
  }

  function parse(query: string): DocumentNode {
    const parsingDidEnd = extensionStack.parsingDidStart({
      queryString: query,
    });

    try {
      return graphql.parse(query);
    } finally {
      parsingDidEnd();
    }
  }

  function validate(document: DocumentNode): ReadonlyArray<GraphQLError> {
    let rules = specifiedRules.concat([CannotDeferNonNullableFields]);
    if (config.validationRules) {
      rules = rules.concat(config.validationRules);
    }

    const validationDidEnd = extensionStack.validationDidStart();

    try {
      return graphql.validate(config.schema, document, rules);
    } finally {
      validationDidEnd();
    }
  }

  async function execute(
    document: DocumentNode,
    operationName: GraphQLRequest['operationName'],
    variables: GraphQLRequest['variables'],
  ): Promise<ExecutionResult | DeferredExecutionResult> {
    const executionArgs: ExecutionArgs = {
      schema: config.schema,
      document,
      rootValue:
        typeof config.rootValue === 'function'
          ? config.rootValue(document)
          : config.rootValue,
      contextValue: requestContext.context,
      variableValues: variables,
      operationName,
      fieldResolver: config.fieldResolver,
      enableDefer: config.enableDefer,
    };

    const executionDidEnd = extensionStack.executionDidStart({
      executionArgs,
    });

    try {
      return executeWithDefer(executionArgs);
    } finally {
      executionDidEnd();
    }
  }

  async function sendResponse(
    response: GraphQLResponse | DeferredGraphQLResponse,
  ): Promise<GraphQLResponse | DeferredGraphQLResponse> {
    if (isDeferredGraphQLResponse(response)) {
      const initialResponse = (response as DeferredGraphQLResponse)
        .initialResponse;
      const requestContextInitialResponse = requestContext.response
        ? (requestContext.response as DeferredGraphQLResponse).initialResponse
        : undefined;

      const r = extensionStack.willSendResponse({
        graphqlResponse: {
          ...requestContextInitialResponse,
          errors: initialResponse.errors,
          data: initialResponse.data,
          extensions: initialResponse.extensions,
        },
        context: requestContext.context,
      });

      requestContext.response = {
        ...(response as DeferredGraphQLResponse),
        initialResponse: r.graphqlResponse,
      } as DeferredGraphQLResponse;
    } else {
      // We override errors, data, and extensions with the passed in response,
      // but keep other properties (like http)
      requestContext.response = extensionStack.willSendResponse({
        graphqlResponse: {
          ...requestContext.response,
          errors: response.errors,
          data: response.data,
          extensions: response.extensions,
        },
        context: requestContext.context,
      }).graphqlResponse;
      await dispatcher.invokeHookAsync(
        'willSendResponse',
        requestContext as WithRequired<typeof requestContext, 'response'>,
      );
    }
    return requestContext.response!;
  }

  function sendErrorResponse(
    errorOrErrors: ReadonlyArray<GraphQLError> | GraphQLError,
    errorClass?: typeof ApolloError,
  ) {
    // If a single error is passed, it should still be encapsulated in an array.
    const errors = Array.isArray(errorOrErrors)
      ? errorOrErrors
      : [errorOrErrors];

    return sendResponse({
      errors: errors.map(err =>
        fromGraphQLError(
          err,
          errorClass && {
            errorClass,
          },
        ),
      ),
    });
  }

  function initializeRequestListenerDispatcher(): Dispatcher<
    GraphQLRequestListener
  > {
    const requestListeners: GraphQLRequestListener<TContext>[] = [];
    if (config.plugins) {
      for (const plugin of config.plugins) {
        if (!plugin.requestDidStart) continue;
        const listener = plugin.requestDidStart(requestContext);
        if (listener) {
          requestListeners.push(listener);
        }
      }
    }
    return new Dispatcher(requestListeners);
  }

  function initializeExtensionStack(): GraphQLExtensionStack<TContext> {
    enableGraphQLExtensions(config.schema);

    // If custom extension factories were provided, create per-request extension
    // objects.
    const extensions = config.extensions ? config.extensions.map(f => f()) : [];

    if (config.tracing) {
      extensions.push(new TracingExtension());
    }

    if (config.cacheControl) {
      cacheControlExtension = new CacheControlExtension(config.cacheControl);
      extensions.push(cacheControlExtension);
    }

    return new GraphQLExtensionStack(extensions);
  }

  function initializeDataSources() {
    if (config.dataSources) {
      const context = requestContext.context;

      const dataSources = config.dataSources();

      for (const dataSource of Object.values(dataSources)) {
        if (dataSource.initialize) {
          dataSource.initialize({
            context,
            cache: requestContext.cache,
          });
        }
      }

      if ('dataSources' in context) {
        throw new Error(
          'Please use the dataSources config option instead of putting dataSources on the context yourself.',
        );
      }

      (context as any).dataSources = dataSources;
    }
  }
}

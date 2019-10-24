import express from 'express';
import {
  GraphQLOptions,
  HttpQueryError,
  runHttpQuery,
  convertNodeHttpToRequest,
} from 'apollo-server-core';
import { ValueOrPromise } from 'apollo-server-types';
import { forAwaitEach } from 'iterall';

export interface ExpressGraphQLOptionsFunction {
  (req: express.Request, res: express.Response): ValueOrPromise<GraphQLOptions>;
}

// Design principles:
// - there is just one way allowed: POST request with JSON body. Nothing else.
// - simple, fast and secure
//

export function graphqlExpress(
  options: GraphQLOptions | ExpressGraphQLOptionsFunction,
): express.Handler {
  if (!options) {
    throw new Error('Apollo Server requires options.');
  }

  if (arguments.length > 1) {
    throw new Error(
      `Apollo Server expects exactly one argument, got ${arguments.length}`,
    );
  }

  return (req, res, next): void => {
    runHttpQuery([req, res], {
      method: req.method,
      options: options,
      query: req.method === 'POST' ? req.body : req.query,
      request: convertNodeHttpToRequest(req),
    }).then(
        // @ts-ignore
      async ({ graphqlResponse, graphqlResponses, responseInit }) => {
        if (responseInit.headers) {
          for (const [name, value] of Object.entries(responseInit.headers)) {
            res.setHeader(name, value);
          }
        }

        if (graphqlResponse) {
          // Using `.send` is a best practice for Express, but we also just use
          // `.end` for compatibility with `connect`.
          if (typeof res.send === 'function') {
            res.send(graphqlResponse);
          } else {
            res.end(graphqlResponse);
          }
        } else if (graphqlResponses) {
          // This is a deferred response, so send it as patches become ready.
          // Update the content type to be able to send multipart data
          // See: https://www.w3.org/Protocols/rfc1341/7_2_Multipart.html
          // Note that we are sending JSON strings, so we can use a simple
          // "-" as the boundary delimiter.
          res.setHeader('Content-Type', 'multipart/mixed; boundary="-"');
          const contentTypeHeader = 'Content-Type: application/json\r\n';
          const boundary = '\r\n---\r\n';
          const terminatingBoundary = '\r\n-----\r\n';
          await forAwaitEach(graphqlResponses, data => {
            // Format each message as a proper multipart HTTP part
            const contentLengthHeader = `Content-Length: ${Buffer.byteLength(
              data as string,
              'utf8',
            ).toString()}\r\n\r\n`;
            res.write(
              boundary + contentTypeHeader + contentLengthHeader + data,
            );
          });

          // Finish up multipart with the last encapsulation boundary
          res.write(terminatingBoundary);
          if (typeof res.send === 'function') {
            res.send(graphqlResponse);
          } else {
            res.end(graphqlResponse);
          }
        }
      },
      (error: HttpQueryError) => {
        if ('HttpQueryError' !== error.name) {
          return next(error);
        }

        if (error.headers) {
          for (const [name, value] of Object.entries(error.headers)) {
            res.setHeader(name, value);
          }
        }

        res.statusCode = error.statusCode;
        if (typeof res.send === 'function') {
          // Using `.send` is a best practice for Express, but we also just use
          // `.end` for compatibility with `connect`.
          res.send(error.message);
        } else {
          res.end(error.message);
        }
      },
    );
  };
}

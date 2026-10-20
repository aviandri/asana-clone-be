import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';

export type ErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'GONE'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'RATE_LIMITED'
  | 'INSUFFICIENT_STORAGE'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  GONE: 410,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  INSUFFICIENT_STORAGE: 507,
};

export class AppError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.statusCode = STATUS[code];
  }
}

export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`);
export const forbidden = (message = 'You do not have permission to do that') =>
  new AppError('FORBIDDEN', message);
export const unauthorized = (message = 'Authentication required') =>
  new AppError('UNAUTHORIZED', message);
export const conflict = (message: string) => new AppError('CONFLICT', message);
export const validation = (message: string, details?: unknown) =>
  new AppError('VALIDATION', message, details);

function body(code: ErrorCode, message: string, details?: unknown) {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

/** Multipart shape limits (too many fields/parts/files): the request is malformed, not too large. */
const MULTIPART_SHAPE = new Set(['FST_FIELDS_LIMIT', 'FST_PARTS_LIMIT', 'FST_FILES_LIMIT']);

/** Headers a byte route may have set before failing; an error is always a JSON envelope. */
const BYTE_HEADERS = ['content-type', 'content-disposition', 'content-length', 'content-range', 'accept-ranges', 'etag'];

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  for (const h of BYTE_HEADERS) reply.removeHeader(h);
  if (MULTIPART_SHAPE.has((err as FastifyError).code)) {
    return reply.status(400).send(body('VALIDATION', 'Send one part named "file" (and at most a "draft" field)'));
  }
  if (err instanceof AppError) {
    return reply.status(err.statusCode).send(body(err.code, err.message, err.details));
  }
  if (err instanceof ZodError) {
    return reply.status(400).send(body('VALIDATION', 'Invalid request', err.issues));
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2025') return reply.status(404).send(body('NOT_FOUND', 'Resource not found'));
    if (err.code === 'P2002') return reply.status(409).send(body('CONFLICT', 'Resource already exists'));
  }
  const status = (err as FastifyError).statusCode;
  if (status && status >= 400 && status < 500) {
    // Fastify-level client errors: malformed JSON, unsupported media type, body too large, ...
    const code: ErrorCode =
      status === 404
        ? 'NOT_FOUND'
        : status === 401
          ? 'UNAUTHORIZED'
          : status === 413
            ? 'PAYLOAD_TOO_LARGE'
            : status === 429
              ? 'RATE_LIMITED'
              : 'VALIDATION';
    return reply.status(status).send(body(code, err.message));
  }
  req.log.error(err);
  return reply.status(500).send(body('INTERNAL', 'Internal server error'));
}

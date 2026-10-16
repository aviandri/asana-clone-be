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
  | 'RATE_LIMITED'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  GONE: 410,
  RATE_LIMITED: 429,
  INTERNAL: 500,
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

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
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
      status === 404 ? 'NOT_FOUND' : status === 401 ? 'UNAUTHORIZED' : status === 429 ? 'RATE_LIMITED' : 'VALIDATION';
    return reply.status(status).send(body(code, err.message));
  }
  req.log.error(err);
  return reply.status(500).send(body('INTERNAL', 'Internal server error'));
}

import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from '../request-context';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const headerValue = req.headers['x-request-id'];
    const requestIdRaw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    const requestId = typeof requestIdRaw === 'string' && requestIdRaw.trim() ? requestIdRaw.trim() : randomUUID();

    res.setHeader('x-request-id', requestId);
    (req as Request & { requestId?: string }).requestId = requestId;

    requestContext.runWithRequestId(requestId, () => {
      next();
    });
  }
}

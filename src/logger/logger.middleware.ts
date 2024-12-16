import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { logger } from "./winston.logger";

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
    use(req: Request, res: Response, next: NextFunction): void {
        const { method, originalUrl, query, body } = req;
        const now = new Date();
        const timestamp = new Intl.DateTimeFormat("en-GB", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        }).format(now);

        logger.info(`Received request: ${req.method} ${req.originalUrl}, query: ${JSON.stringify(query)}, body: ${JSON.stringify(body)}`);
        next();
    }
}

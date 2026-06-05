import winston from "winston";

export class RedisLogger {
  private logger: winston.Logger;

  public constructor(logger?: winston.Logger) {
    this.logger = logger ?? RedisLogger.createDefaultLogger();
  }

  private static createDefaultLogger(): winston.Logger {
    const isProd = process.env.NODE_ENV === "production";

    return winston.createLogger({
      level: isProd ? "info" : "debug",
      format: isProd
        ? winston.format.combine(
            winston.format.timestamp(),
            winston.format.json(),
          )
        : winston.format.combine(
            winston.format.timestamp({ format: "HH:mm:ss" }),
            winston.format.colorize(),
            winston.format.printf(
              ({ level, message, timestamp, context, ...meta }) => {
                const ctx = context ? `[${context}]` : "";
                const metaStr = Object.keys(meta).length
                  ? ` ${JSON.stringify(meta)}`
                  : "";
                return `${timestamp} ${level} ${ctx} ${message}${metaStr}`;
              },
            ),
          ),
      transports: [new winston.transports.Console()],
    });
  }

  public info(
    message: string,
    context?: string,
    meta?: Record<string, unknown>,
  ) {
    this.logger.info(message, { context, ...meta });
  }

  public warn(
    message: string,
    context?: string,
    meta?: Record<string, unknown>,
  ) {
    this.logger.warn(message, { context, ...meta });
  }

  public error(
    message: string,
    context?: string,
    meta?: Record<string, unknown>,
  ) {
    this.logger.error(message, { context, ...meta });
  }

  public debug(
    message: string,
    context?: string,
    meta?: Record<string, unknown>,
  ) {
    this.logger.debug(message, { context, ...meta });
  }
}

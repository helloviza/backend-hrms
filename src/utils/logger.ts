import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import path from "path";

const { combine, timestamp, errors, json, colorize, printf } = winston.format;

const isDev = process.env.NODE_ENV !== "production";

// Console format for development — human readable
const devFormat = combine(
  colorize(),
  timestamp({ format: "HH:mm:ss" }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length
      ? "\n" + JSON.stringify(meta, null, 2)
      : "";
    return `${timestamp} [${level}]: ${stack || message}${metaStr}`;
  })
);

// JSON format for production — structured, parseable
const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
);

const transports: winston.transport[] = [
  new winston.transports.Console({
    format: isDev ? devFormat : prodFormat,
    silent: process.env.NODE_ENV === "test",
  }),
];

// File transports — only in production or if LOG_TO_FILE=true
if (!isDev || process.env.LOG_TO_FILE === "true") {
  // Error log — kept for 30 days
  transports.push(
    new DailyRotateFile({
      filename: path.join("logs", "error-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      level: "error",
      maxFiles: "30d",
      zippedArchive: true,
    })
  );

  // Combined log — kept for 14 days
  transports.push(
    new DailyRotateFile({
      filename: path.join("logs", "combined-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxFiles: "14d",
      zippedArchive: true,
    })
  );
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
  transports,
  // Don't crash on unhandled promise rejections
  exitOnError: false,
});

export default logger;

// Named child loggers for different modules
export const authLogger = logger.child({ module: "auth" });
export const sbtLogger = logger.child({ module: "sbt" });
export const paymentLogger = logger.child({ module: "payment" });
export const webhookLogger = logger.child({ module: "webhook" });

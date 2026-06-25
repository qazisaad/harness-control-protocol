export type RunnerLogger = {
  info(message: string): void;
  error(message: string): void;
};

export const consoleLogger: RunnerLogger = {
  info(message: string): void {
    console.log(message);
  },
  error(message: string): void {
    console.error(message);
  },
};

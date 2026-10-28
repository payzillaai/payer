export function createPrompts(o: {
  stdin?: NodeJS.ReadStream;
  stderr?: NodeJS.WriteStream;
  refuse: (text: string) => Error;
  cancelled: () => Error;
}): {
  readSecret(prompt: string): Promise<string>;
  readLine(prompt: string): Promise<string | null>;
};

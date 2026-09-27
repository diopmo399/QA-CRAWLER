import { redactText } from '../security/redactor.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (text: string) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);

export const color = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
};

/** Sortie console de la CLI. Tout passe par le masquage des secrets. */
export const logger = {
  info(message: string): void {
    console.log(redactText(message));
  },
  warn(message: string): void {
    console.warn(color.yellow(redactText(message)));
  },
  error(message: string): void {
    console.error(color.red(redactText(message)));
  },
};

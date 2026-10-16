import bcrypt from 'bcryptjs';

// bcryptjs is pure JS (no native build). Cost 10 keeps login ~fast on a small box.
const ROUNDS = process.env.NODE_ENV === 'test' ? 4 : 10;

export const hashPassword = (plain: string) => bcrypt.hash(plain, ROUNDS);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

/** Compared against when the email is unknown, so response timing doesn't reveal which emails exist. */
export const DUMMY_HASH = bcrypt.hashSync('dummy-password-never-matches', ROUNDS);

const AVATAR_COLORS = [
  '#e8384f', '#fd612c', '#fd9a00', '#eec300', '#a4cf30', '#62d26f',
  '#37c5ab', '#20aaea', '#4186e0', '#7a6ff0', '#aa62e3', '#e362e3',
];

export function randomAvatarColor(): string {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]!;
}

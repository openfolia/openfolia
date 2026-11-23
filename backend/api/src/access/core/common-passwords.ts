/**
 * The bundled list of common passwords (#610), lowercase: the words and phrases people pick
 * most, compiled for this project, without names of companies, products, clubs or bands. `passwordProblem` (`passwords.ts`) refuses a password that
 * is one of them, or one of them with digits or symbols around it, letters swapped for
 * look-alike digits, or repeated, so a list of bases covers their long variants
 * (`Password1234!`, `qwertyqwerty`, `P@ssw0rd2024`).
 */
const WORDS = `
123456 1234567 12345678 123456789 1234567890 0123456789 987654321 9876543210 654321 123123
111111 000000 121212 112233 123321 159753 147258 147258369 159357 789456 456789 102030
abc123 abcdef abcd1234 qwerty qwertz azerty qwerty123 qwertyuiop asdfgh asdfghjkl zxcvbn
zxcvbnm 1q2w3e 1q2w3e4r 1q2w3e4r5t 1qaz2wsx qazwsx qweasd qweasdzxc asdf1234 zaq12wsx
password passwort passwd pass pa55word motdepasse contrasena contrasenya wachtwoord salasana
haslo parola senha passord losenord adgangskode jelszo
letmein welcome welcome1 hello hallo hellothere iloveyou iloveu loveyou lovely love
admin administrator root superuser master secret private changeme default guest user login
test testing tester demo sample example temp temporary access system server
monkey dragon shadow sunshine princess football baseball basketball soccer hockey
matrix trustno1 whatever
freedom liberty summer winter spring autumn flower flowers butterfly rainbow
michael jennifer jessica ashley daniel andrew joshua thomas charlie robert matthew
jordan hunter ranger buster tigger ginger pepper cookie chocolate banana orange apple
computer internet windows
killer hacker cheese coffee money mustang
schatz schatzi hallo123 geheim kennwort sommer winter herbst fruehling
qwertz123 ichliebedich liebe hase mausi
letmein123 welcome123 password123 admin123 root123 test123
nothing someone anything everything forever always
`;

/** Long favourites, kept whole. */
const PHRASES = `
iloveyouforever iloveyousomuch iloveyoubaby iloveyoumom iloveyoudad iloveyou2
thequickbrownfox thequickbrownfoxjumpsoverthelazydog correcthorsebatterystaple
letmeinplease openthedoor opensesame changemenow changethispassword
mypassword mypassword123 mysecretpassword supersecret supersecretpassword
passwordpassword password1password verysecure verysecurepassword strongpassword
newpassword oldpassword thisismypassword thisisapassword notmypassword
nopassword passwordispassword ihatepasswords
administrator1 administrator123 superadministrator
qwertyuiopasdfghjklzxcvbnm abcdefghijklmnopqrstuvwxyz abcdefghijkl
1234567890qwertyuiop qwertyuiop1234567890 1qaz2wsx3edc4rfv 1q2w3e4r5t6y7u8i9o0p
zaq1xsw2cde3vfr4 qazwsxedcrfv qazwsxedc123 asdfghjkl123 zxcvbnm123456
q1w2e3r4t5y6 a1b2c3d4e5f6 abc123abc123 aaaaaaaaaaaa
welcometothejungle happybirthday merrychristmas happynewyear
ichliebedichsehr ichbineinberliner allesgutezumgeburtstag
`;

/** The common passwords and bases, lowercase, each once. */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set(
  `${WORDS} ${PHRASES}`.split(/\s+/).filter(Boolean),
);

/** Rows of a keyboard and runs of the alphabet and digits, for "a run along them". */
export const SEQUENCES: readonly string[] = [
  'abcdefghijklmnopqrstuvwxyz',
  '0123456789',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  'qwertzuiop',
  'yxcvbnm',
  'azertyuiop',
  'wxcvbn',
  '1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p',
];

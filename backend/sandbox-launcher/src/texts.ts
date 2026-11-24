// Every text of the start page, in English and German (German with "Sie"). The page's script
// reads the ones it shows later (starting, full, error) from the page itself, so it holds no
// text of its own. A test keeps both languages' keys the same and every key used.

export type PageLang = 'en' | 'de';
export const PAGE_LANGS: readonly PageLang[] = ['en', 'de'];

const en = {
  'page.title': 'Try OpenFolia: a sandbox of your own',
  'page.description':
    'Try the OpenFolia editor in a private sandbox: sample manuals, three demo people, no sign-up.',
  'header.docs': 'Documentation',
  'header.language': 'Language',
  'header.theme.dark': 'Dark theme',
  'header.theme.light': 'Light theme',
  live: 'Live demo',
  'live.free': 'Live demo · {free} of {capacity} sandboxes free',
  'live.full': 'Live demo · all sandboxes in use',
  'ready.title': 'Try OpenFolia in a sandbox',
  'ready.titleSoft': 'of your own.',
  'ready.lede':
    "The whole editor with sample content: an owner's manual and a service booklet for an invented car, in English and German. Two releases with their PDFs, and a revision waiting for review.",
  'people.label': 'The demo people',
  'people.author.role': 'Author',
  'people.author.does': 'Writes modules and starts revisions.',
  'people.reviewer.role': 'Reviewer',
  'people.reviewer.does': 'Comments on changes and approves them.',
  'people.admin.role': 'Admin',
  'people.admin.does': 'Merges approved work and cuts releases.',
  'people.note': 'Switch between them at any time from the account menu.',
  'private.title': 'Your own sandbox: only you see it.',
  'private.text':
    'It is deleted after the session: after {idle} minutes without activity, or {max} minutes at most. Nothing you write leaves it.',
  'facts.ready.title': 'Ready in about 3 s',
  'facts.ready.text': 'No sign-up.',
  'facts.browser.title': 'Only this browser',
  'facts.browser.text': 'A shared link opens this page.',
  'facts.gone.title': 'Gone afterwards',
  'facts.gone.text': 'Content, comments, PDFs.',
  'start.button': 'Start the demo',
  'start.contentLang': 'Content in',
  'start.fine': 'One sandbox at a time, {daily} a day per address.',
  'start.ended':
    'Your last sandbox has ended and was deleted. You can start a new one.',
  'start.noScript':
    'The demo needs JavaScript: your browser does a short calculation before a sandbox starts.',
  'ended.title': 'Thanks for trying OpenFolia.',
  'ended.closed': 'Your sandbox has ended, and everything in it was deleted.',
  'ended.expired':
    'Your sandbox has ended, and everything in it was deleted: a sandbox ends after {idle} minutes without activity, or after {max} minutes at the latest.',
  'ended.booking':
    'Want to see OpenFolia with your own content and questions? Book a demo: a guided walk-through, at a time that suits you.',
  'ended.again.lede': 'You can start a new sandbox at any time.',
  'ended.book': 'Book a demo',
  'ended.again': 'Start a new sandbox',
  'ended.portal': 'See the published manuals',
  'ended.close': 'Close',
  'starting.title': 'Starting your sandbox',
  'starting.lede':
    "A fresh copy of the demo, just for you. You'll be in the editor as Mira Sand, the author, in a moment.",
  'starting.step.check': 'Checking your browser',
  'starting.step.check.sub': 'A short calculation instead of a captcha.',
  'starting.step.start': 'Starting your sandbox',
  'starting.step.start.sub': 'Its own editor, API and database.',
  'starting.step.open': 'Opening the editor',
  'starting.tip':
    'Only this browser can open it. A link to it shows others this page.',
  'starting.seconds': '{seconds} s',
  'full.title': 'All sandboxes are taken',
  'full.titleSoft': 'right now.',
  'full.lede':
    'Every visitor gets a sandbox of their own, and they are all in use. One is usually free again within a few minutes.',
  'full.ledeFilms':
    'Every visitor gets a sandbox of their own, and they are all in use. One is usually free again within a few minutes. Meanwhile, watch what you would do in it.',
  'full.inUse': '{capacity} of {capacity} in use',
  'full.retryIn': "We'll try again for you in {time}.",
  'full.retrying': 'Trying again…',
  'full.retry': 'Try again',
  'films.label': 'The demo on film',
  'films.hero': 'OpenFolia in two minutes',
  'films.editor': 'Writing a module',
  'films.review': 'Reviewing a change',
  'films.manual-builder': 'Building a manual',
  'films.releases': 'Cutting a release',
  'films.play': 'Play: {title}',
  'error.title': "Your sandbox didn't start.",
  'error.lede':
    "Something went wrong on our side. What was started has been removed, and this attempt doesn't count towards your {daily} a day.",
  'error.retry': 'Try again',
  'error.films': 'Watch the films instead',
  'error.reference': 'Reference: {reference}',
  'error.network.lede':
    "The launcher didn't answer. Check your connection and try again.",
  'limit.daily.title': "You've had your sandboxes for today.",
  'limit.daily.lede':
    'Each address can start {daily} sandboxes in 24 hours. You can start the next one at {time}.',
  'limit.once.title': 'You already have a sandbox open.',
  'limit.once.lede':
    'Each address can have one sandbox at a time. Open it in the browser you started it in, or wait until it has ended.',
  'limit.rate.title': 'Too many requests.',
  'limit.rate.lede': 'Please wait a moment, then try again.',
  'footer.licence':
    'OpenFolia is open source (AGPL-3.0). This demo keeps nothing after your session.',
  'footer.portal': 'Published manuals',
  'footer.abuse': 'Report abuse:',
  'page.skip': 'Skip to content',
  'header.homepage': 'OpenFolia: homepage',
  'footer.label': 'About this demo',
  'footer.homepage': 'Homepage',
  'footer.data': 'What this demo stores',
  'footer.imprint': 'Imprint',
  'footer.privacy': 'Privacy',
  'data.pageTitle': 'What this demo stores · OpenFolia',
  'data.title': 'What this demo stores',
  'data.lede':
    'Only what it needs to give you a sandbox and to keep the demo fair to everyone, and only for as long as it needs it.',
  'data.cookie.title': 'One cookie, strictly necessary',
  'data.cookie.text':
    'When you start a sandbox, the demo sets one cookie: a random key that ties this browser to your sandbox. The demo cannot work without it, so it needs no consent. It holds nothing about you, the page cannot read it, and it expires with your sandbox, after {max} minutes at the latest.',
  'data.address.title': 'Your IP address, only as a keyed hash',
  'data.address.text':
    'To hold each address to its limits ({once} at a time, {daily} in 24 hours), the demo keeps a keyed hash of your IP address (HMAC-SHA-256 with a secret key of this deployment) and the times you started a sandbox. Your address itself is never stored and never passed to your sandbox. The hash is kept in memory for 24 hours at most and never written to a log.',
  'data.content.title': 'Your sandbox, until it ends',
  'data.content.text':
    'What you write, comment on and publish lives only in your sandbox, and is deleted with it: after {idle} minutes without activity, after {max} minutes at the latest, or when the demo restarts.',
  'data.logs.title': 'Logs without addresses or content',
  'data.logs.text':
    'The demo logs when sandboxes start, end or are refused, and why. Its logs carry no IP addresses, no cookies and nothing you write.',
  'data.none':
    'No tracking, no analytics, no third parties: the fonts, images and films come from this server.',
  'data.operator':
    'This describes the demo software. What the operator’s servers record besides is described in their privacy policy.',
  'data.back': 'Back to the start page',
} as const;

export type TextKey = keyof typeof en;

const de: Record<TextKey, string> = {
  'page.title': 'OpenFolia ausprobieren: Ihre eigene Sandbox',
  'page.description':
    'Probieren Sie den OpenFolia-Editor in einer privaten Sandbox aus: Beispielanleitungen, drei Demo-Personen, ohne Anmeldung.',
  'header.docs': 'Dokumentation',
  'header.language': 'Sprache',
  'header.theme.dark': 'Dunkles Design',
  'header.theme.light': 'Helles Design',
  live: 'Live-Demo',
  'live.free': 'Live-Demo · {free} von {capacity} Sandboxen frei',
  'live.full': 'Live-Demo · alle Sandboxen belegt',
  'ready.title': 'Probieren Sie OpenFolia in einer Sandbox',
  'ready.titleSoft': 'nur für Sie.',
  'ready.lede':
    'Der ganze Editor mit Beispielinhalten: eine Betriebsanleitung und ein Serviceheft für ein erfundenes Auto, auf Englisch und Deutsch. Zwei Veröffentlichungen mit ihren PDFs und eine Überarbeitung, die auf ihre Prüfung wartet.',
  'people.label': 'Die Demo-Personen',
  'people.author.role': 'Autorin',
  'people.author.does': 'Schreibt Module und beginnt Überarbeitungen.',
  'people.reviewer.role': 'Prüfer',
  'people.reviewer.does': 'Kommentiert Änderungen und gibt sie frei.',
  'people.admin.role': 'Administratorin',
  'people.admin.does':
    'Führt Freigegebenes zusammen und erstellt Veröffentlichungen.',
  'people.note': 'Sie wechseln jederzeit zwischen ihnen, über das Kontomenü.',
  'private.title': 'Ihre eigene Sandbox: nur Sie sehen sie.',
  'private.text':
    'Sie wird nach der Sitzung gelöscht: nach {idle} Minuten ohne Aktivität, spätestens nach {max} Minuten. Nichts, was Sie schreiben, verlässt sie.',
  'facts.ready.title': 'Bereit in etwa 3 s',
  'facts.ready.text': 'Ohne Anmeldung.',
  'facts.browser.title': 'Nur dieser Browser',
  'facts.browser.text': 'Ein geteilter Link öffnet diese Seite.',
  'facts.gone.title': 'Danach gelöscht',
  'facts.gone.text': 'Inhalte, Kommentare, PDFs.',
  'start.button': 'Demo starten',
  'start.contentLang': 'Inhalte auf',
  'start.fine': 'Eine Sandbox zur Zeit, {daily} am Tag pro Adresse.',
  'start.ended':
    'Ihre letzte Sandbox ist beendet und wurde gelöscht. Sie können eine neue starten.',
  'start.noScript':
    'Die Demo braucht JavaScript: Ihr Browser macht eine kurze Rechnung, bevor eine Sandbox startet.',
  'ended.title': 'Danke, dass Sie OpenFolia ausprobiert haben.',
  'ended.closed': 'Ihre Sandbox ist beendet, und alles darin wurde gelöscht.',
  'ended.expired':
    'Ihre Sandbox ist abgelaufen, und alles darin wurde gelöscht: Eine Sandbox endet nach {idle} Minuten ohne Aktivität, spätestens nach {max} Minuten.',
  'ended.booking':
    'Möchten Sie OpenFolia mit Ihren eigenen Inhalten und Fragen sehen? Buchen Sie eine Demo: eine geführte Vorstellung, zu einem Termin, der Ihnen passt.',
  'ended.again.lede': 'Sie können jederzeit eine neue Sandbox starten.',
  'ended.book': 'Demo buchen',
  'ended.again': 'Neue Sandbox starten',
  'ended.portal': 'Veröffentlichte Anleitungen ansehen',
  'ended.close': 'Schließen',
  'starting.title': 'Ihre Sandbox startet',
  'starting.lede':
    'Eine frische Kopie der Demo, nur für Sie. Gleich sind Sie im Editor, als Mira Sand, die Autorin.',
  'starting.step.check': 'Ihr Browser wird geprüft',
  'starting.step.check.sub': 'Eine kurze Rechnung statt eines Captchas.',
  'starting.step.start': 'Ihre Sandbox startet',
  'starting.step.start.sub': 'Mit eigenem Editor, eigener API und Datenbank.',
  'starting.step.open': 'Der Editor öffnet sich',
  'starting.tip':
    'Nur dieser Browser kann sie öffnen. Ein Link darauf zeigt anderen diese Seite.',
  'starting.seconds': '{seconds} s',
  'full.title': 'Alle Sandboxen sind belegt',
  'full.titleSoft': 'gerade.',
  'full.lede':
    'Jede Besucherin und jeder Besucher bekommt eine eigene Sandbox, und alle sind in Gebrauch. Meist ist in wenigen Minuten wieder eine frei.',
  'full.ledeFilms':
    'Jede Besucherin und jeder Besucher bekommt eine eigene Sandbox, und alle sind in Gebrauch. Meist ist in wenigen Minuten wieder eine frei. Sehen Sie sich so lange an, was Sie darin tun würden.',
  'full.inUse': '{capacity} von {capacity} belegt',
  'full.retryIn': 'Wir versuchen es in {time} erneut für Sie.',
  'full.retrying': 'Neuer Versuch …',
  'full.retry': 'Erneut versuchen',
  'films.label': 'Die Demo im Film',
  'films.hero': 'OpenFolia in zwei Minuten',
  'films.editor': 'Ein Modul schreiben',
  'films.review': 'Eine Änderung prüfen',
  'films.manual-builder': 'Eine Anleitung zusammenstellen',
  'films.releases': 'Eine Veröffentlichung erstellen',
  'films.play': 'Abspielen: {title}',
  'error.title': 'Ihre Sandbox ist nicht gestartet.',
  'error.lede':
    'Bei uns ist etwas schiefgegangen. Was schon gestartet war, ist entfernt, und dieser Versuch zählt nicht zu Ihren {daily} am Tag.',
  'error.retry': 'Erneut versuchen',
  'error.films': 'Stattdessen die Filme ansehen',
  'error.reference': 'Referenz: {reference}',
  'error.network.lede':
    'Der Launcher hat nicht geantwortet. Prüfen Sie Ihre Verbindung und versuchen Sie es erneut.',
  'limit.daily.title': 'Ihre Sandboxen für heute sind aufgebraucht.',
  'limit.daily.lede':
    'Jede Adresse kann in 24 Stunden {daily} Sandboxen starten. Die nächste können Sie um {time} starten.',
  'limit.once.title': 'Sie haben schon eine Sandbox geöffnet.',
  'limit.once.lede':
    'Jede Adresse kann eine Sandbox zur Zeit haben. Öffnen Sie sie in dem Browser, in dem Sie sie gestartet haben, oder warten Sie, bis sie abgelaufen ist.',
  'limit.rate.title': 'Zu viele Anfragen.',
  'limit.rate.lede':
    'Bitte warten Sie einen Moment und versuchen Sie es dann erneut.',
  'footer.licence':
    'OpenFolia ist Open Source (AGPL-3.0). Diese Demo behält nichts nach Ihrer Sitzung.',
  'footer.portal': 'Veröffentlichte Anleitungen',
  'footer.abuse': 'Missbrauch melden:',
  'page.skip': 'Zum Inhalt',
  'header.homepage': 'OpenFolia: Startseite',
  'footer.label': 'Über diese Demo',
  'footer.homepage': 'Startseite',
  'footer.data': 'Was diese Demo speichert',
  'footer.imprint': 'Impressum',
  'footer.privacy': 'Datenschutz',
  'data.pageTitle': 'Was diese Demo speichert · OpenFolia',
  'data.title': 'Was diese Demo speichert',
  'data.lede':
    'Nur, was sie braucht, um Ihnen eine Sandbox zu geben und die Demo für alle fair zu halten, und nur so lange, wie sie es braucht.',
  'data.cookie.title': 'Ein Cookie, technisch notwendig',
  'data.cookie.text':
    'Wenn Sie eine Sandbox starten, setzt die Demo ein Cookie: einen zufälligen Schlüssel, der diesen Browser mit Ihrer Sandbox verbindet. Ohne ihn funktioniert die Demo nicht, daher braucht er keine Einwilligung. Er enthält nichts über Sie, die Seite kann ihn nicht lesen, und er läuft mit Ihrer Sandbox ab, spätestens nach {max} Minuten.',
  'data.address.title': 'Ihre IP-Adresse, nur als Hash mit geheimem Schlüssel',
  'data.address.text':
    'Damit jede Adresse ihre Grenzen einhält ({once} gleichzeitig, {daily} in 24 Stunden), speichert die Demo einen Hash Ihrer IP-Adresse mit geheimem Schlüssel (HMAC-SHA-256 mit einem Schlüssel dieser Installation) und die Zeitpunkte Ihrer Starts. Ihre Adresse selbst wird nie gespeichert und nie an Ihre Sandbox weitergegeben. Der Hash bleibt höchstens 24 Stunden im Arbeitsspeicher und wird nie protokolliert.',
  'data.content.title': 'Ihre Sandbox, bis sie endet',
  'data.content.text':
    'Was Sie schreiben, kommentieren und veröffentlichen, liegt nur in Ihrer Sandbox und wird mit ihr gelöscht: nach {idle} Minuten ohne Aktivität, spätestens nach {max} Minuten oder wenn die Demo neu startet.',
  'data.logs.title': 'Protokolle ohne Adressen und Inhalte',
  'data.logs.text':
    'Die Demo protokolliert, wann Sandboxen starten, enden oder abgelehnt werden, und warum. Ihre Protokolle enthalten keine IP-Adressen, keine Cookies und nichts von dem, was Sie schreiben.',
  'data.none':
    'Kein Tracking, keine Analyse, keine Dritten: Schriften, Bilder und Filme kommen von diesem Server.',
  'data.operator':
    'Dies beschreibt die Demo-Software. Was die Server des Betreibers darüber hinaus aufzeichnen, steht in dessen Datenschutzerklärung.',
  'data.back': 'Zurück zur Startseite',
};

export const TEXTS: Readonly<
  Record<PageLang, Readonly<Record<TextKey, string>>>
> = { en, de };

/** A text with its `{name}` placeholders filled. */
export function text(
  lang: PageLang,
  key: TextKey,
  values: Readonly<Record<string, string | number>> = {},
): string {
  return TEXTS[lang][key].replace(/\{(\w+)\}/g, (_, name: string) =>
    String(values[name] ?? `{${name}}`),
  );
}

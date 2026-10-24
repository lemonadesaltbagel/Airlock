/**
 * Identifier parts generic enough to appear in any codebase. An identifier built only from
 * these (`user_id`, `maxRetries`, `parseConfigFile`) says nothing about a project; one with
 * any other part (`surgeMultiplier`, `FleetwiseClient`) might, so the gate treats it as
 * project-specific. Erring towards "specific" costs a rewrite, not a leak.
 */
const WORDS = `
a abs abstract accept access account acc action active actual add addr address admin after agent
algo algorithm alias all alloc allow alpha amount and any api app append apply arg args argv array
as ascii assert async at attr attribute auth author auto avg await back backend base basic batch be
before begin best beta big bin binary bind bit bits block body bool boolean both bottom bound bounds
box break buf buffer bug build builder bulk button by byte bytes cache calc call callback can cancel
cap case cast catch cell change channel char chars check child children chunk class clean clear
cli click client clone close cls cmd code col collection color column columns command comment
commit common compare compile complete component compute concat cond condition config conn
connect connection console const constant constructor consumer contains content context continue
control convert copy core count counter create created ctx cur current cursor custom cwd data
database date day db debug dec decimal decode default define del delay delete delta dep depth
desc describe destroy detail dev dict diff dir direction directory disable dispatch display dist
div do doc document done double down download draw driver dst dummy dump duration dynamic each
edge edit element else empty enable encode end endpoint engine entity entries entry enum env
eq equal err error errors event events every example exception exec execute exist exists exit exp
expected export expr expression ext extend extra factory fail failed false fetch field fields file
filename files fill filter final find first fixed flag flags float flush fn focus foo bar baz qux
for format forward frame free from front full func function gen generate generator get global go
graph group handle handler has hash head header headers height help helper hidden high history
hook host hour html http https id idx if image impl import in inc include index info init initial
inner input insert instance int integer interface internal interval into is item items iter
iterator job join json key keys kind label last layer layout lazy left len length level lib limit
line lines link list listener load loader local lock log logger login logout long loop low lower
main make manager map mapping mark match max mem member memory merge message meta method mid
middleware min minute mock mod mode model module month move msg multi mutex my name names native
need net network new next no node nodes none normal not null num number obj object of off offset
ok old on one only op open operation operator opt option options or order out outer output over
override owner pack package page pair param params parent parse parser part partial pass password
patch path pattern payload peek pending per perf pick pipe pixel plain point pointer policy pool
pop port pos position post pre prefix prev print priority private process prod producer profile
program progress project prop props proto protocol provider proxy public pull push put query queue
quick random range rate raw re read reader ready real reason record records recv reduce ref
refresh regex register registry release remote remove render repeat replace reply repo report req
request require reset resolve resource response rest result results ret retry return rev reverse
right role root round route router row rows rule run runner runtime safe sample save scale scan
schema scope score script search second section seed select self send sender seq sequence server
service session set setting settings setup shape shared shift short should show side sig sign
signal simple single size skip sleep slice slot small socket sort source span spec split sql src
stack start state static stats status std stderr stdin stdout step stop storage store str stream
string struct style sub submit success sum super swap switch symbol sync system tab table tag
tail target task temp template term test text thread threshold time timeout timer timestamp title
tmp to token tokens tool top total trace track transform tree trigger trim true try tuple type
types ui uid unique unit unknown up update upload upper uri url usage use used user users util
utils uuid val valid validate validator value values var variable vec vector version view visit
wait walk warn warning watch week weight when while width window with word work worker wrap
write writer x y z year yield zero zone
assertequal assertequals unittest pytest fixture mock setup teardown describe expect
workspace repo project projects app apps discover verbose quiet usage readme instead
`;

export const COMMON_PARTS: ReadonlySet<string> = new Set(WORDS.split(/\s+/).filter(Boolean));

/** Split an identifier into lower-case parts: camelCase, PascalCase, snake_case, digits. */
export function identifierParts(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
}

/** Canonical form so `SurgeMultiplier`, `surge_multiplier` and `surgeMultiplier` compare equal. */
export function canonicalIdentifier(identifier: string): string {
  return identifierParts(identifier).join("_");
}

function singular(part: string): string[] {
  if (part.endsWith("ies")) return [part.slice(0, -3) + "y"];
  if (part.endsWith("es")) return [part.slice(0, -2), part.slice(0, -1)];
  if (part.endsWith("s")) return [part.slice(0, -1)];
  return [];
}

export function isCommonPart(part: string): boolean {
  return COMMON_PARTS.has(part) || /^\d+$/.test(part) || part.length <= 2 || singular(part).some((s) => COMMON_PARTS.has(s));
}

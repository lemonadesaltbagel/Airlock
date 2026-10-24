/**
 * Names from standard libraries and common frameworks. They appear in any project that uses
 * the technology, so they reveal the stack (safe to share), not the project.
 * Matched case-sensitively against identifiers.
 */
const PYTHON = `
Any Callable ClassVar Dict Final Generator Generic Iterable Iterator List Literal Mapping MutableMapping
NamedTuple Optional Protocol Sequence Set Tuple Type TypeVar TypedDict Union Self Awaitable AsyncIterator
dataclass dataclasses field fields asdict astuple replace frozen default_factory post_init __post_init__
Decimal ROUND_HALF_UP ROUND_HALF_EVEN ROUND_DOWN ROUND_UP ROUND_CEILING ROUND_FLOOR ROUND_HALF_DOWN
InvalidOperation getcontext localcontext quantize as_tuple Fraction
datetime timedelta timezone tzinfo ZoneInfo zoneinfo strftime strptime isoformat fromisoformat utcnow
fromtimestamp
defaultdict OrderedDict Counter deque namedtuple ChainMap most_common
heapq heappush heappop heapify heapreplace heappushpop nlargest nsmallest bisect bisect_left bisect_right
insort functools lru_cache cache partial reduce total_ordering cached_property wraps itertools chain
groupby islice accumulate combinations permutations product zip_longest pairwise
math isclose floor ceil sqrt log exp inf nan isfinite isnan fsum statistics median mean stdev quantiles
pathlib Path os sys json loads dumps csv DictReader DictWriter reader writer re compile fullmatch findall
finditer sub split enum Enum IntEnum StrEnum auto abc ABC abstractmethod contextlib contextmanager
threading Thread Lock RLock Event Condition Semaphore queue Queue asyncio gather create_task subprocess
logging getLogger unittest TestCase setUp tearDown setUpClass tearDownClass subTest skipIf
assertEqual assertNotEqual assertTrue assertFalse assertIs assertIsNot assertIsNone assertIsNotNone
assertIn assertNotIn assertIsInstance assertRaises assertRaisesRegex assertAlmostEqual assertNotAlmostEqual
assertGreater assertGreaterEqual assertLess assertLessEqual assertCountEqual assertDictEqual assertListEqual
mock patch MagicMock pytest fixture parametrize raises approx __init__ __repr__ __str__ __eq__ __hash__
__lt__ __le__ __gt__ __ge__ __len__ __iter__ __next__ __getitem__ __setitem__ __contains__ __enter__
__exit__ __call__ __name__ __main__ __all__ __future__ annotations isinstance issubclass enumerate sorted
reversed staticmethod classmethod property super hasattr getattr setattr ValueError TypeError KeyError
IndexError RuntimeError NotImplementedError AttributeError ZeroDivisionError StopIteration Exception
python python3 pip README pyproject setuptools
`;

const JS_TS = `
Promise Array Map Set WeakMap WeakSet Object JSON Math Number String Boolean Symbol BigInt Date RegExp
Error TypeError RangeError SyntaxError console setTimeout clearTimeout setInterval clearInterval
structuredClone queueMicrotask globalThis Record Partial Required Readonly Pick Omit Exclude Extract
ReturnType Parameters Awaited NonNullable Uint8Array ArrayBuffer TextEncoder TextDecoder AbortController
AbortSignal fetch Request Response Headers URL URLSearchParams useState useEffect useMemo useCallback
useRef useContext React ReactNode Component Fragment describe expect toEqual toBe toThrow beforeEach
afterEach vitest jest node npm package tsconfig typescript
`;

export const PUBLIC_API_NAMES: ReadonlySet<string> = new Set(`${PYTHON} ${JS_TS}`.split(/\s+/).filter(Boolean));

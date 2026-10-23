// The Forecast: which tasks belong to it, in what order, and which of them are
// folded behind the horizon. It is written once as pure functions over tasks so
// that the list a terminal prints and the list a browser draws can share one
// definition and not drift apart. `tdo forecast` reads it today; the viewer's
// `app.js` still carries its own copy of these rules, to be replaced by it.
//
// The rules were first written inside the viewer's `app.js` (the `PERSPECTIVES`
// entry keyed `due`, `byDateThen`, `beyondHorizon` and `landed`); this is that
// logic, copied. A Forecast is not a saved perspective: it is not a filter the
// store can run, because it sorts by one date and falls back to the other,
// and folds a tail by a calendar distance from now.
//
// This module must run in a browser, so it imports only the task model.
import { KindTask, statusClosed } from "./task.js";
/** The orders, in the order a front end offers them; defer is the default. */
export const ForecastOrders = ['defer', 'due'];
/**
 * ForecastHorizonDays is how far ahead the Forecast looks. A Forecast is about
 * the week in front of you: what is already here, and what arrives over the
 * next seven days. Something released in three weeks is a fact about the list
 * and not news about today, so it is still in the view — folded to the end,
 * not filtered away, which would be a different and more dishonest thing.
 */
export const ForecastHorizonDays = 7;
const msPerDay = 86_400_000;
/**
 * today is the calendar day `now` falls on *where the program runs* — the
 * browser's zone in the viewer, the process's in the CLI — written as that
 * day at 00:00:00Z so it compares with a stored date. Dates are stored as
 * UTC midnights, but "today" is the reader's: at 01:00 in Tokyo it is already
 * tomorrow, and counting the day in UTC kept the Forecast on yesterday until
 * breakfast. The zone is whatever the runtime reports, never a constant.
 */
export function today(now) {
    return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}
/**
 * calendarDays counts whole calendar days from `now` to `at`. `at` is read in UTC and `now` in the local zone (see `today`). It is a
 * calendar question and not an hourly one: an item due at midnight this
 * morning is still due today, an hour overdue, and calling that "yesterday" is
 * how a list starts lying to its reader. UTC is the same frame `--due
 * 2026-11-01` is written in, which is that day at 00:00:00Z.
 */
export function calendarDays(at, now) {
    const a = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
    const n = today(now).getTime();
    return Math.round((a - n) / msPerDay);
}
/**
 * inForecast reports whether a task belongs to the Forecast: a task, not
 * finished or dropped, carrying either date.
 *
 * Tasks only. A project carries a due date of its own, which read as work to
 * do and was not: a project is a container, and the thing to do is whichever
 * of its tasks is next. Either date qualifies, because defer is the order the
 * Forecast is read in out of the box, and a default order over a list the date
 * is missing from would leave out exactly the items it is sorted by.
 */
export function inForecast(t) {
    return (t.kind === KindTask &&
        !statusClosed(t.status) &&
        !t.deleted() &&
        (t.dueAt !== undefined || t.deferAt !== undefined));
}
/**
 * landed reports whether the day an item is due has come: due today or on any
 * day before it. It is what the Forecast's badge counts — a calendar question,
 * so something due at 18:00 has landed at breakfast, and a forecast that waits
 * until 18:01 to say so is useless in the morning.
 */
export function landed(t, now) {
    return t.dueAt !== undefined && !statusClosed(t.status) && calendarDays(t.dueAt, now) <= 0;
}
/**
 * pastDue reports that an item is from an earlier day: due on any day before
 * today. It is a different question from "overdue", which is about the
 * instant, and it is the one a Forecast needs. A due date written as a day is
 * midnight, so everything due today is overdue by breakfast — true, and
 * useless for telling today's work apart from last week's. There is no Past
 * bucket to separate them (see `forecastDays`), so this is what a front end
 * colours by and what a terminal can mark.
 */
export function pastDue(t, now) {
    return t.dueAt !== undefined && !statusClosed(t.status) && calendarDays(t.dueAt, now) < 0;
}
/** beyondHorizon reports whether a task is deferred past the horizon. */
export function beyondHorizon(t, now) {
    return t.deferAt !== undefined && calendarDays(t.deferAt, now) > ForecastHorizonDays;
}
/**
 * byDateThen orders by the date named first, standing in the other date where
 * the named one is missing: an item with no defer date is available already,
 * so in defer order it belongs where its deadline puts it rather than dumped
 * at the end — and an overdue item at the bottom of a forecast is exactly the
 * failure to avoid. Ties break on the title so the order is stable between
 * runs.
 */
function byDateThen(first, second) {
    const keyOf = (t) => (t[first] ?? t[second])?.getTime();
    return (a, b) => {
        const x = keyOf(a);
        const y = keyOf(b);
        if (x === undefined) {
            return y === undefined ? 0 : 1;
        }
        if (y === undefined) {
            return -1;
        }
        return x - y || a.title.localeCompare(b.title);
    };
}
const sorts = {
    defer: byDateThen('deferAt', 'dueAt'),
    due: byDateThen('dueAt', 'deferAt'),
};
/**
 * forecast selects, orders and splits the Forecast out of any list of tasks.
 * One function, because the fold's own count and the rows it hides have to
 * agree. The input is not modified.
 */
export function forecast(tasks, order, now) {
    const items = tasks.filter(inForecast).sort(sorts[order]);
    return {
        near: items.filter((t) => !beyondHorizon(t, now)),
        later: items.filter((t) => beyondHorizon(t, now)),
    };
}
/** forecastOrder validates a user-supplied order, or returns undefined. */
export function forecastOrder(value) {
    return ForecastOrders.includes(value) ? value : undefined;
}
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** ForecastWeekDays is how many columns the week has: today and six more. */
export const ForecastWeekDays = 7;
/**
 * ForecastMaxDays is the longest run of days a caller may ask for. The limit
 * is not about cost — the days are cut out of a list already in memory — but
 * about the answer staying one: past a couple of months of headings the
 * reader is no longer looking at a forecast, and `tdo ls --sort due` is the
 * question they actually have.
 */
export const ForecastMaxDays = 60;
/**
 * forecastDays is the week, today first.
 *
 * `count` is how many days to lay out, the week by default. A shorter run is
 * the same days cut short; a longer one keeps going past the fold, which is
 * deliberate: `ForecastHorizonDays` is where the *flat* list stops trusting a
 * defer date to be news, and a reader who asked for thirty days of headings
 * has said they want the days anyway.
 *
 * There is no "Past" column. **Today carries everything already due**, which
 * is what a day opened in the morning has to say: an overdue bill is today's
 * problem, and filing it under a day that has gone is how it stops being
 * looked at. What separates the two inside today's list is `pastDue` — a
 * colour in the viewer, a mark in the terminal — not a bucket of its own.
 *
 * The keys are stable while the labels are not: Thursday is `d4` today and
 * `d3` tomorrow, and a view held open across midnight should follow the day
 * it means rather than the name it had.
 */
export function forecastDays(now, count = ForecastWeekDays) {
    const days = [];
    for (let i = 0; i < count; i += 1) {
        const date = new Date(today(now).getTime() + i * msPerDay);
        const isToday = i === 0;
        days.push({
            key: isToday ? 'today' : `d${i}`,
            label: isToday ? 'Today' : WEEKDAYS[date.getUTCDay()],
            date,
            today: isToday,
            dueMatch: isToday ? (d) => d <= 0 : (d) => d === i,
            startMatch: (d) => d === i,
        });
    }
    return days;
}
/**
 * forecastDay looks a day up by key, or returns undefined. `count` is the run
 * of days the key is looked for in, the week by default.
 */
export function forecastDay(key, now, count = ForecastWeekDays) {
    return forecastDays(now, count).find((d) => d.key === key);
}
/**
 * dueOn is what a day's number counts: the deadlines that land on it. Tasks
 * only, as `inForecast` has it, so that the number is the number of rows the
 * day opens.
 */
export function dueOn(tasks, day, now) {
    return tasks.filter((t) => inForecast(t) && t.dueAt !== undefined && day.dueMatch(calendarDays(t.dueAt, now)));
}
/** noneHeld is `held` when the caller has not asked what is blocking what. */
const noneHeld = new Set();
/**
 * startsOn is the other half: what becomes available that day. It is counted
 * apart from the deadlines, because a deadline and a release are not the same
 * news — a day showing "5" that turns out to be five things that merely became
 * available reads as pressure that is not there, and the one real deadline
 * hides inside it.
 *
 * A defer date that has passed belongs to no day, with one exception: a task in
 * `held` — one something other than its own defer date is still blocking. An
 * available one is on Next from then on; a blocked one is on no list that says
 * "now", so its date would vanish the moment it came. Today keeps it until
 * what blocks it goes. `held` is the ids; core cannot compute availability.
 */
export function startsOn(tasks, day, now, held = noneHeld) {
    return tasks.filter((t) => inForecast(t) &&
        t.deferAt !== undefined &&
        (day.startMatch(calendarDays(t.deferAt, now)) ||
            (day.today && calendarDays(t.deferAt, now) < 0 && held.has(t.id))));
}
/**
 * forecastOn is one day of the week: everything it has to say, deadlines
 * first and then what is released, never the same task twice, in the order
 * the whole Forecast is read in.
 */
export function forecastOn(tasks, day, order, now, held = noneHeld) {
    const items = dueOn(tasks, day, now);
    const seen = new Set(items.map((t) => t.id));
    for (const t of startsOn(tasks, day, now, held)) {
        if (!seen.has(t.id)) {
            items.push(t);
        }
    }
    return items.sort(sorts[order]);
}
//# sourceMappingURL=forecast.js.map
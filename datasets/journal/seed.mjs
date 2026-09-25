/**
 * Builds datasets/journal/journal.db from schema.sql plus generated content.
 *
 *     node seed.mjs
 *
 * Everything here is deterministic. The random number generator is seeded with
 * a constant, the date range is fixed, and no value is taken from the clock or
 * the environment. Running this on any machine produces a byte-identical set of
 * rows, which is what lets the book print a query result and have it still be
 * true on the reader's copy.
 *
 * The content is invented. Entries and credentials are generated; the password
 * hash is random hex and authenticates nothing. The quotes are real ones.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(HERE, "journal.db");

const SEED = 0x5c17e; // change this and every row in the book changes with it
const FIRST_DAY = "2024-01-01";
const LAST_DAY = "2025-12-31";

// The session table is written relative to a fixed instant rather than now(),
// so "expired" and "active" stay stable forever.
const CLOCK = "2026-01-15 09:00:00"; // UTC, in the format SQLite itself uses

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/** mulberry32: small, fast, and identical across platforms and Node versions. */
function makeRandom(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = makeRandom(SEED);

// A second, independent stream decides which entries are missing a mood or
// tags. Drawing those from `rand` would shift every value after the first draw
// and reshuffle the whole journal; a separate stream leaves the rest untouched.
const gaps = makeRandom(SEED + 1);

const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const chance = (p) => rand() < p;

/** Weighted pick from an object of {key: weight}. */
function pickWeighted(weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rand() * total;
  for (const [key, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return key;
  }
  return entries.at(-1)[0];
}

/**
 * Take n distinct keys from a {key: weight} map, without replacement, honouring
 * the weights. Sampling secondary tags uniformly instead would flatten the
 * distribution — the rare tags would collect so many secondary appearances that
 * they stopped being rare.
 */
function sampleWeighted(weights, n, exclude) {
  const pool = { ...weights };
  delete pool[exclude];
  const out = [];
  while (out.length < n && Object.keys(pool).length > 0) {
    const key = pickWeighted(pool);
    delete pool[key];
    out.push(key);
  }
  return out;
}

const hex = (n) =>
  Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

// The weights are the shape of a real journal: a few subjects dominate and the
// long tail is genuinely thin. It matters because it gives index selectivity
// something to be different about in Part IV.
const TAGS = {
  relationship: 64,
  coding: 51,
  exercise: 46,
  work: 31,
  cat: 26,
  music: 24,
  health: 22,
  sports: 15,
  social: 12,
  gardening: 9,
};

// Created, and never used. A tag on no entry is what makes LEFT JOIN and
// NOT EXISTS return something an inner join cannot.
const UNUSED_TAGS = ["travel"];

// The mood vocabulary itself lives in schema.sql and is read back from the
// database below, so there is no second copy here to fall out of step with it.

// Which moods each subject tends to arrive with. Not a clean mapping — a day
// about work is usually tense and occasionally the best day of the month —
// but skewed enough that GROUP BY on it says something.
const MOOD_BY_TAG = {
  relationship: { happy: 5, grateful: 4, sad: 3, calm: 3, frustrated: 2, anxious: 2, proud: 1, determined: 1 },
  coding: { determined: 5, frustrated: 5, proud: 4, calm: 3, anxious: 2, happy: 2, grateful: 1, sad: 1 },
  exercise: { proud: 5, determined: 4, happy: 3, calm: 3, grateful: 2, frustrated: 2, anxious: 1, sad: 1 },
  work: { frustrated: 6, anxious: 5, determined: 3, calm: 3, proud: 2, sad: 2, happy: 1, grateful: 1 },
  cat: { happy: 6, grateful: 5, calm: 2, sad: 2, anxious: 1, proud: 1, determined: 1, frustrated: 1 },
  music: { happy: 4, grateful: 3, proud: 3, determined: 3, calm: 3, frustrated: 2, sad: 2, anxious: 1 },
  health: { anxious: 5, determined: 4, grateful: 3, calm: 3, frustrated: 3, sad: 2, happy: 1, proud: 1 },
  sports: { happy: 4, frustrated: 4, proud: 3, calm: 3, sad: 2, determined: 2, grateful: 1, anxious: 1 },
  social: { happy: 5, grateful: 4, calm: 3, anxious: 3, sad: 2, proud: 1, determined: 1, frustrated: 1 },
  gardening: { grateful: 5, calm: 4, happy: 3, proud: 3, determined: 2, frustrated: 2, sad: 1, anxious: 1 },
};

// Each scene is [title, sentence, months?]. The title travels with the sentence
// so an entry called "Barbecue" is never about board games, and the optional
// month list keeps the first frost out of July.
const SCENES = {
  relationship: [
    ["Long talk", "We talked for an hour after dinner without either of us reaching for a phone, which is rarer than it should be."],
    ["Dinner at home", "She got back late and we ended up eating at half past nine, standing in the kitchen."],
    ["We argued", "A small thing turned into an argument about something else entirely, the way it always does."],
    ["Walk together", "We walked the long way around the park and did not say much, and it was fine."],
    ["Cooked together", "Cooked together for the first time in weeks. She chopped, I burned the garlic."],
    ["Away until Sunday", "She is at her parents until Sunday and the flat is very quiet."],
    ["Booked the trip", "We booked the trip. Two nights, nothing planned, which was the whole point."],
    ["Apologised", "I apologised badly, then apologised properly about an hour later."],
    ["Quiet evening", "Sat on the balcony until it got cold, talking about whether to move."],
    ["She noticed", "She noticed I had been off all week before I had noticed it myself."],
    ["Sunday morning", "Sunday morning, no alarm, coffee in bed, nowhere to be until two."],
    ["Money again", "We disagreed about money again. Same conversation, slightly better ending."],
  ],
  coding: [
    ["Chasing a bug", "Spent most of the day on a bug that turned out to be a missing index on a foreign key."],
    ["Migration finally landed", "The migration finally landed. Three weeks of work and the deploy took forty seconds."],
    ["Rewrote the parser", "Rewrote the parser properly instead of patching it again, and it is half the size now."],
    ["Query from hell", "A query that used to take four seconds now takes eleven milliseconds. I am still slightly suspicious."],
    ["Broke production", "Broke production for about six minutes. Rolled back, fixed it, wrote the postmortem."],
    ["Pair session", "Paired with someone new on the team and explained the whole data model out loud, which is the fastest way to find out what you do not understand."],
    ["Deploy day", "Deployed twice, reverted once, deployed again. The third one held."],
    ["Off by one", "Read the same twenty lines for an hour before noticing the comparison was backwards."],
    ["Cleared the backlog", "Cleared the entire review backlog. Twelve pull requests, none of them mine."],
    ["Tests first", "Wrote tests first for once and the feature took less time, which I will forget again by next week."],
    ["Pipeline red", "The deployment pipeline was red all morning for reasons that had nothing to do with our code."],
    ["Less code", "Deleted four hundred lines and nothing broke. Best kind of day."],
  ],
  exercise: [
    ["Ten kilometres", "Ran ten kilometres along the canal, slower than last week but it never felt hard."],
    ["Back to the gym", "Back to the gym after eleven days off. Everything is heavier than I left it."],
    ["Hill repeats", "Hill repeats. Six of them, and the last two were mostly willpower."],
    ["Morning swim", "Swam in the morning before work, which meant getting up at half five and being useless by three."],
    ["Skipped it", "Skipped the session. It rained, and I was not going to pretend that was not the reason."],
    ["New personal best", "New personal best on the five kilometre loop, by nine seconds."],
    ["Easy pace", "Easy pace, no watch, just went out for forty minutes."],
    ["Legs are done", "Legs are completely done. Walking down stairs is a negotiation."],
    ["Head torch", "First run in the dark this season, head torch and everything.", [10, 11, 12, 1, 2]],
    ["All the way through", "Did the whole session without stopping, which I could not do in January."],
    ["Stretched, finally", "Stretched properly afterwards for the first time in months."],
    ["Went out too fast", "Went out too fast and paid for it in the last two kilometres."],
  ],
  work: [
    ["Sprint planning", "Sprint planning ran ninety minutes over and we came out with the same list we went in with."],
    ["Too many meetings", "Four meetings before lunch and no time to actually do anything between them."],
    ["Deadline moved", "The deadline moved again, which nobody is calling a delay."],
    ["Performance review", "Performance review. Better than I expected, and I did not know how to take the good parts."],
    ["Quiet office", "Half the office is on leave and it was the most productive day I have had in a month."],
    ["Handover", "Wrote the handover document. It is longer than the project was."],
    ["New project", "New project kicked off. Nobody can say in one sentence what it is for yet."],
    ["Interview panel", "Sat on an interview panel all afternoon. Harder work than it looks."],
    ["Working late", "Stayed until eight to finish something that could have waited until Monday."],
    ["How are you", "My manager asked how I was and waited for the real answer."],
    ["Document wars", "Spent the day in a document arguing about a decision that was already made."],
    ["Last day before leave", "Last day before leave, and I cleared everything, which almost never happens."],
  ],
  cat: [
    ["Vet visit", "Took Pilot to the vet. Nothing wrong, forty euros to be told so, and she sulked all evening."],
    ["Pilot on the windowsill", "She spent the entire afternoon on the windowsill watching one particular bird."],
    ["Knocked over the plant", "Knocked the plant off the shelf again. Same plant, same shelf, third time."],
    ["Sleeping on the keyboard", "Fell asleep on the keyboard while I was working, and I let her stay there."],
    ["New scratching post", "Bought a new scratching post. She has inspected it and decided in favour of the sofa."],
    ["She came home", "She was out all night and came back at six as if nothing had happened."],
    ["Purring all evening", "Sat on my chest purring for twenty minutes, which fixed most of the day."],
    ["Chasing shadows", "Chasing the reflection off my watch around the living room for a solid ten minutes."],
    ["Feeding time", "Would not eat the new food. We have gone back to the old food."],
    ["Hiding again", "Hiding under the bed since the neighbours started drilling."],
    ["The cupboard", "She has worked out how to open the cupboard, which is a problem for later."],
  ],
  music: [
    ["Barre chords", "An hour of guitar practice, mostly barre chords, and my hand gave out before the hour did."],
    ["New record", "New record arrived and I listened to the whole thing sitting down, no phone, all the way through."],
    ["Wrote a riff", "Wrote a riff I actually like and recorded it on my phone so I would not lose it."],
    ["Concert", "Concert. Stood too close to the speakers and could not hear properly until Tuesday."],
    ["Strings changed", "Changed the strings, which I put off for about four months."],
    ["Learning the solo", "Learned the solo, badly, but the shape of it is there now."],
    ["Old albums", "Played through old albums from when I was nineteen and most of them hold up."],
    ["Jam in the garage", "Jammed with two friends in their garage for three hours. No plan, no recording."],
    ["Four takes", "Recorded four takes and used none of them."],
    ["Scales", "Practised scales for twenty minutes and it was as boring as it sounds and it works."],
    ["That one bar", "Finally got the timing on that one bar that has been wrong for weeks."],
  ],
  health: [
    ["Doctor", "Doctor at half eight. Bloods taken, results next week, told not to worry in a way that makes you worry."],
    ["Slept badly", "Slept badly, maybe four hours in pieces, and the whole day ran at half speed."],
    ["Headache all day", "Headache from about eleven until I gave up and went to bed early."],
    ["Cut out coffee", "Cut out coffee after two in the afternoon and slept better within three days."],
    ["Back pain", "Back has been bad since the weekend. Sitting is worse than standing."],
    ["Dentist", "Dentist. No fillings, which I treated as a personal achievement."],
    ["Feeling better", "First day of actually feeling better after a week of not."],
    ["Physio", "Physio gave me four exercises and I have done them twice."],
    ["Early night", "Went to bed at half nine and it was the right decision."],
    ["Eye strain", "The eye strain is back, which means I have stopped taking breaks again."],
    ["Blood test", "Blood test results came back fine and I felt the tension go out of my shoulders reading them."],
  ],
  sports: [
    ["We lost", "Match day. We lost two nil and deserved worse."],
    ["Late equaliser", "Late equaliser in the ninety fourth minute and the whole bar stood up at once."],
    ["Watching the race", "Watched the race with the sound off and the radio commentary on, which is the correct way."],
    ["Derby", "Derby. Nothing to separate them and a point each felt fair."],
    ["Training cancelled", "Training cancelled because half the pitch was under water.", [10, 11, 12, 1, 2, 3]],
    ["Season opener", "Season opener, new kit, same defending.", [8, 9]],
    ["Podium finish", "Podium finish from twelfth on the grid, which does not happen often."],
    ["Final", "Final went to penalties and I could not watch the last two.", [5, 6]],
    ["First game back", "Played on Sunday morning for the first time since the injury."],
    ["Six games left", "We are third with six games left and I refuse to get excited about it."],
  ],
  social: [
    ["Birthday", "Birthday. Small, six people, food at home, and it was exactly the right size."],
    ["Board games", "Friends over for board games and the evening ran until one in the morning."],
    ["Dinner out", "Dinner out at a new café. Too loud to talk and the food was worth it anyway."],
    ["Coffee with an old friend", "Coffee with an old friend I had not seen since before the move. Two hours disappeared."],
    ["Wedding", "Wedding. Long day, good speeches, home late and completely done."],
    ["Cancelled plans", "Cancelled the plans and felt relieved, then slightly guilty about the relief."],
    ["Barbecue", "Barbecue at theirs. It rained for an hour and everyone stayed outside anyway.", [5, 6, 7, 8, 9]],
    ["Long lunch", "Long lunch that turned into a long afternoon."],
    ["House party", "House party where I knew exactly one person, which was fine for about ninety minutes."],
    ["Said yes", "Said yes to something I would normally say no to, and was glad."],
  ],
  gardening: [
    ["Tomatoes", "The tomatoes are finally doing something. Six of them, still green.", [6, 7, 8, 9]],
    ["Repotting", "Repotted everything that had outgrown its pot, which was most things.", [3, 4, 5, 9]],
    ["First frost", "First frost overnight, so the tender things came inside.", [10, 11, 12]],
    ["Weeding", "An hour of weeding, which is the only gardening I find genuinely calming.", [4, 5, 6, 7, 8, 9]],
    ["Seeds in", "Seeds in. Basil, coriander, and something I have already lost the label for.", [3, 4, 5]],
    ["Harvest", "Harvested more courgettes than two people can reasonably eat.", [7, 8, 9, 10]],
    ["Pruned everything", "Pruned everything back hard and the balcony looks empty and will not in April.", [10, 11, 2, 3]],
    ["Compost", "Started the compost properly instead of the bucket approach."],
    ["Slugs again", "Slugs have found the seedlings. Again.", [4, 5, 6, 7, 8]],
    ["New herbs", "New herbs on the kitchen windowsill, which get used and therefore survive."],
  ],
};

const REFLECTIONS = {
  frustrated: [
    "It is the second time this week and I can feel myself getting short with people over it.",
    "None of it was anyone's fault, which somehow made it worse.",
    "I know it will look small in a week. It does not look small today.",
    "Went to bed annoyed, which never helps and I did it anyway.",
    "The problem is not the thing, it is that the thing keeps coming back.",
    "Spent more energy being irritated about it than it would have taken to fix.",
  ],
  anxious: [
    "Could not settle to anything all evening, kept checking my phone for no reason.",
    "The worry is out of proportion to the thing and knowing that does not help.",
    "Woke at four and lay there running through it until it got light.",
    "Wrote the list down, which usually shrinks it, and this time it did a bit.",
    "Kept rehearsing the conversation instead of having it.",
    "It sat in my chest all day, low and constant, and eased off after dinner.",
  ],
  grateful: [
    "Small day, nothing remarkable, and I noticed halfway through that I was content.",
    "Reminded myself that a year ago this would have been out of reach.",
    "Nothing here is guaranteed and I do not want to need reminding of that.",
    "Felt lucky, in the specific rather than the vague sense.",
    "The ordinary version of this is the good version and I keep forgetting.",
    "Went to sleep thinking about how much worse the alternative would be.",
  ],
  happy: [
    "One of those days that does not need writing down and I am writing it down anyway.",
    "Caught myself in a good mood for no traceable reason.",
    "Laughed properly for the first time in a while.",
    "Nothing needed fixing today, which is its own kind of luxury.",
    "Nothing was solved and it did not matter.",
    "Good day. Straightforwardly good, which I should record more often.",
  ],
  calm: [
    "An unremarkable day, which after the last few is not a complaint.",
    "Nothing much happened and nothing much needed to.",
    "Flat, not bad. Somewhere in the middle and stable there.",
    "A day that will not be distinguishable from any other in six months.",
    "Ticked over. Not a bad way to spend a Tuesday.",
    "Steady. I will take steady.",
  ],
  proud: [
    "Six months ago I could not have done this and I want that on the record.",
    "Nobody else would notice the difference, and I know what it took.",
    "Did the thing I said I would do, on the day I said I would do it.",
    "Small, but it is mine and it is finished.",
    "Let myself be pleased about it for a whole evening instead of moving straight on.",
    "The version of me who started this would not believe today.",
  ],
  sad: [
    "A heaviness I could not put a cause to, which is the harder kind.",
    "Missed people today. Nothing to do about that except say it.",
    "It came and went in waves and by evening it had mostly gone.",
    "Cried a bit, which I do not do often, and felt better afterwards.",
    "Everything took twice the effort it should have.",
    "Sat with it rather than trying to fix it, which is new.",
  ],
  determined: [
    "Made the plan properly this time, with dates on it.",
    "Starting tomorrow, and I have removed the excuses in advance.",
    "Not motivated, just decided, which I am told is the more durable one.",
    "Committed to eight weeks. If it does not work I will at least know.",
    "Wrote down exactly what done looks like so I cannot move the line later.",
    "One step a day. That is the whole strategy and it is enough.",
  ],
};

// [text, months?]
const OPENERS = [
  ["Rain all day."],
  ["Rained on and off."],
  ["Grey from the moment I got up."],
  ["Woke up early without meaning to."],
  ["Slow start, two coffees before anything sensible happened."],
  ["Up at six, coffee, out the door."],
  ["Cold and clear.", [11, 12, 1, 2, 3]],
  ["Dark by half four.", [11, 12, 1]],
  ["Snow overnight, barely any of it left by noon.", [12, 1, 2]],
  ["Wind all night, hardly slept.", [10, 11, 12, 1, 2, 3]],
  ["First proper sun in weeks.", [2, 3, 4]],
  ["Warm enough to have the windows open.", [5, 6, 7, 8, 9]],
  ["Too hot to do anything before six.", [6, 7, 8]],
];

const CLOSERS = [
  "Early night.",
  "Read for twenty minutes and put the light out.",
  "Tomorrow is busier.",
  "Same again tomorrow, probably.",
  "Left the washing up.",
  "Worth remembering.",
];

// Attributions are to the source, in a common English translation, and none is
// one of the famous misattributions. The author strings are what matter to the
// book: three NULLs, and the same name stored with different capitalisation,
// including a non-ASCII one that NOCASE cannot fold.
const QUOTES = [
  ["The unexamined life is not worth living.", "Socrates"],
  ["The impediment to action advances action. What stands in the way becomes the way.", "Marcus Aurelius"],
  ["Very little is needed to make a happy life; it is all within yourself, in your way of thinking.", "marcus aurelius"],
  ["We suffer more often in imagination than in reality.", "Seneca"],
  ["It is not that we have a short time to live, but that we waste a lot of it.", "seneca"],
  ["First say to yourself what you would be; and then do what you have to do.", "Epictetus"],
  ["No man ever steps in the same river twice.", "Heraclitus"],
  ["Fall seven times, stand up eight.", null],
  ["Do the hard thing while it is still small.", null],
  ["If we have our own why of life, we shall get along with almost any how.", "Friedrich Nietzsche"],
  ["The best time to plant a tree was twenty years ago. The second best time is now.", null],
  ["You could leave life right now. Let that determine what you do and say and think.", "Marcus Aurelius"],
  ["Waste no more time arguing what a good man should be. Be one.", "MARCUS AURELIUS"],
  ["Men are disturbed not by things, but by the views which they take of things.", "Epictetus"],
  ["While we are postponing, life speeds by.", "Seneca"],
  ["Begin at once to live, and count each separate day as a separate life.", "Seneca"],
  ["Life can only be understood backwards; but it must be lived forwards.", "Søren Kierkegaard"],
  ["Anxiety is the dizziness of freedom.", "SØREN KIERKEGAARD"],
];

// The journal has one owner, and every session belongs to them.
const OWNER = "matt";

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
/** 'YYYY-MM-DD HH:MM:SS', UTC: the format of CURRENT_TIMESTAMP and datetime(). */
const sqliteTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const monthOf = (day) => Number(day.slice(5, 7));

function everyDay(from, to) {
  const out = [];
  for (let ms = Date.parse(from); ms <= Date.parse(to); ms += DAY_MS) out.push(iso(ms));
  return out;
}

/**
 * Whether an entry exists for each day, as a two-state Markov chain: you are
 * much more likely to write today if you wrote yesterday. That produces runs
 * and gaps rather than an even sprinkle, which is what makes "longest writing
 * streak" a real question later in the book.
 */
function writingDays(days) {
  const KEEP_GOING = 0.55; // wrote yesterday -> write today
  const START_AGAIN = 0.18; // did not -> write today
  const out = [];
  let wroteYesterday = false;
  for (const day of days) {
    wroteYesterday = chance(wroteYesterday ? KEEP_GOING : START_AGAIN);
    if (wroteYesterday) out.push(day);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry text
// ---------------------------------------------------------------------------

/** Members of xs whose optional month list allows this month. */
function inSeason(xs, month, monthsAt) {
  const ok = xs.filter((x) => {
    const months = monthsAt(x);
    return !months || months.includes(month);
  });
  return ok.length > 0 ? ok : xs;
}

const seasonalScenes = (tag, month) => inSeason(SCENES[tag], month, (s) => s[2]);
const seasonalOpeners = (month) => inSeason(OPENERS, month, (o) => o[1]);

function buildEntry(month, primaryTag, secondaryTags, mood) {
  const parts = [];

  if (chance(0.45)) parts.push(pick(seasonalOpeners(month))[0]);

  const [title, scene] = pick(seasonalScenes(primaryTag, month));
  parts.push(scene);

  // A second scene only ever comes from a *different* tag. Two scenes from the
  // same tag contradict each other far too often ("we argued" / "quiet evening").
  if (secondaryTags.length > 0 && chance(0.65)) {
    parts.push(pick(seasonalScenes(pick(secondaryTags), month))[1]);
  }

  const reflections = REFLECTIONS[mood];
  const first = pick(reflections);
  parts.push(first);
  if (chance(0.3)) {
    const second = pick(reflections);
    if (second !== first) parts.push(second);
  }

  if (chance(0.35)) parts.push(pick(CLOSERS));

  return { title, content: parts.join(" ") };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(DB_PATH + suffix, { force: true });
}

const db = new DatabaseSync(DB_PATH);
db.exec(readFileSync(join(HERE, "schema.sql"), "utf8"));

const tagNames = Object.keys(TAGS);
const tagId = new Map(tagNames.map((name, i) => [name, i + 1]));

// Read the moods back rather than assuming this file lists them in the same
// order schema.sql inserts them. Getting that wrong would not fail — it would
// quietly label every entry with the wrong mood.
const moodId = new Map(
  db.prepare("SELECT id, name FROM mood").all().map((row) => [row.name, row.id]),
);

for (const [tag, weights] of Object.entries(MOOD_BY_TAG)) {
  if (!TAGS[tag]) throw new Error(`MOOD_BY_TAG has an unknown tag: ${tag}`);
  for (const mood of Object.keys(weights)) {
    if (!moodId.has(mood)) throw new Error(`MOOD_BY_TAG[${tag}] has an unknown mood: ${mood}`);
  }
}
for (const tag of tagNames) {
  if (!MOOD_BY_TAG[tag]) throw new Error(`no mood weights for tag: ${tag}`);
  if (!SCENES[tag]) throw new Error(`no scenes for tag: ${tag}`);
}
for (const mood of moodId.keys()) {
  if (!REFLECTIONS[mood]) throw new Error(`no reflections for mood: ${mood}`);
}

db.exec("BEGIN");

const insertTag = db.prepare("INSERT INTO tag (id, name) VALUES (?, ?)");
for (const name of tagNames) insertTag.run(tagId.get(name), name);
UNUSED_TAGS.forEach((name, i) => insertTag.run(tagNames.length + i + 1, name));

const insertEntry = db.prepare(
  "INSERT INTO entry (date, title, content, mood_id) VALUES (?, ?, ?, ?)",
);
const insertEntryTag = db.prepare("INSERT INTO entry_tag (entry_id, tag_id) VALUES (?, ?)");

for (const day of writingDays(everyDay(FIRST_DAY, LAST_DAY))) {
  const month = monthOf(day);
  const primary = pickWeighted(TAGS);
  const mood = pickWeighted(MOOD_BY_TAG[primary]);

  // Most entries carry one tag; a few carry up to five more.
  const extraCount = Number(pickWeighted({ 0: 52, 1: 26, 2: 12, 3: 6, 4: 3, 5: 1 }));
  const secondary = sampleWeighted(TAGS, extraCount, primary);

  const { title, content } = buildEntry(month, primary, secondary, mood);

  // Choosing a mood and tagging are both optional in the application, and a
  // few entries skip them. The text is still written as if they had not.
  const moodless = gaps() < 0.03;
  const untagged = gaps() < 0.01;

  const { lastInsertRowid } = insertEntry.run(
    day,
    title,
    content,
    moodless ? null : moodId.get(mood),
  );
  if (untagged) continue;
  for (const tag of [primary, ...secondary]) {
    insertEntryTag.run(Number(lastInsertRowid), tagId.get(tag));
  }
}

const insertQuote = db.prepare("INSERT INTO quote (id, content, author) VALUES (?, ?, ?)");
QUOTES.forEach(([content, author], i) => insertQuote.run(i + 1, content, author));

db.prepare("INSERT INTO user (id, username, passwordhash, salt) VALUES (1, ?, ?, ?)").run(
  OWNER,
  hex(128),
  hex(32),
);

// A dozen sessions across the owner's phone, laptop and work machine, four of
// them already expired as of CLOCK, so the prune query in the application
// chapters has something to delete.
const insertSession = db.prepare(
  "INSERT INTO session (session_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
);
const clockMs = Date.parse(CLOCK);
for (let i = 0; i < 12; i++) {
  const createdMs = clockMs - Math.floor(rand() * 40 * DAY_MS);
  const expiresMs = createdMs + 30 * DAY_MS;
  insertSession.run(hex(64), 1, sqliteTime(createdMs), sqliteTime(expiresMs));
}

db.exec("COMMIT");

// Statistics for the query planner, so EXPLAIN QUERY PLAN output in the book
// matches what the reader gets.
db.exec("ANALYZE");
db.exec("VACUUM");
db.close();

const counts = new DatabaseSync(DB_PATH, { readOnly: true });
const report = (label, sql) =>
  console.log(label.padEnd(12), String(counts.prepare(sql).get().n));
report("entry", "SELECT count(*) n FROM entry");
report("entry_tag", "SELECT count(*) n FROM entry_tag");
report("tag", "SELECT count(*) n FROM tag");
report("mood", "SELECT count(*) n FROM mood");
report("quote", "SELECT count(*) n FROM quote");
report("user", "SELECT count(*) n FROM user");
report("session", "SELECT count(*) n FROM session");
counts.close();

console.log(`\nwrote ${DB_PATH}`);

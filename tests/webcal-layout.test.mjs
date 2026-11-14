import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  calculateTypographyScale,
  calculateWeekTimeRange,
  getTimedEventSlots,
} from "../applications/webcal/assets/calendar-layout.js";

test("week ends one clear hour after the latest event end", () => {
  assert.deepEqual(
    calculateWeekTimeRange([{ start: 16 * 60, end: 17 * 60 + 15 }]),
    { startHour: 8, endHour: 19 },
  );
  assert.deepEqual(
    calculateWeekTimeRange([{ start: 19 * 60, end: 20 * 60 }]),
    { startHour: 8, endHour: 22 },
  );
});

test("timed events crossing midnight create both local-day slots", () => {
  const slots = getTimedEventSlots(
    [{
      start: { dateTime: "2026-11-14T23:30:00+01:00" },
      end: { dateTime: "2026-11-15T02:30:00+01:00" },
    }],
    ["2026-11-14", "2026-11-15"],
    "Europe/Berlin",
  );
  assert.deepEqual(slots, [
    { start: 23 * 60 + 30, end: 24 * 60 },
    { start: 0, end: 2 * 60 + 30 },
  ]);
  assert.deepEqual(calculateWeekTimeRange(slots), {
    startHour: 0,
    endHour: 24,
  });
});

test("week keeps its default range when there are no timed events", () => {
  assert.deepEqual(calculateWeekTimeRange([]), {
    startHour: 8,
    endHour: 18,
  });
  assert.deepEqual(calculateWeekTimeRange([{ start: NaN, end: NaN }]), {
    startHour: 8,
    endHour: 18,
  });
});

test("start hour remains based on the full seven-day range in portrait", () => {
  assert.deepEqual(
    calculateWeekTimeRange(
      [
        { start: 5 * 60, end: 6 * 60 },
        { start: 9 * 60, end: 10 * 60 },
      ],
      [{ start: 9 * 60, end: 10 * 60 }],
    ),
    { startHour: 5, endHour: 12 },
  );
});

test("midnight and multi-day event segments extend through the day boundary", () => {
  assert.deepEqual(
    calculateWeekTimeRange([
      { start: 23 * 60, end: 24 * 60 },
      { start: 0, end: 2 * 60 + 30 },
    ]),
    { startHour: 0, endHour: 24 },
  );
  assert.deepEqual(
    calculateWeekTimeRange([
      { start: 9 * 60, end: 24 * 60 },
      { start: 0, end: 15 * 60 },
    ]),
    { startHour: 0, endHour: 24 },
  );
});

test("latest event on the fifth portrait day sets the dynamic end", () => {
  const slots = getTimedEventSlots(
    [{
      start: { dateTime: "2026-11-18T16:00:00+01:00" },
      end: { dateTime: "2026-11-18T17:15:00+01:00" },
    }],
    ["2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18"],
    "Europe/Berlin",
  );
  assert.deepEqual(calculateWeekTimeRange(slots), {
    startHour: 8,
    endHour: 19,
  });
});

test("latest event on the seventh landscape day sets the dynamic end", () => {
  const slots = getTimedEventSlots(
    [{
      start: { dateTime: "2026-11-20T19:00:00+01:00" },
      end: { dateTime: "2026-11-20T20:00:00+01:00" },
    }],
    [
      "2026-11-14",
      "2026-11-15",
      "2026-11-16",
      "2026-11-17",
      "2026-11-18",
      "2026-11-19",
      "2026-11-20",
    ],
    "Europe/Berlin",
  );
  assert.deepEqual(calculateWeekTimeRange(slots), {
    startHour: 8,
    endHour: 22,
  });
});

test("all-day events do not affect the timed range", () => {
  assert.deepEqual(
    getTimedEventSlots(
      [{ start: { date: "2026-11-14" }, end: { date: "2026-11-15" } }],
      ["2026-11-14", "2026-11-15"],
      "Europe/Berlin",
    ),
    [],
  );
});

test("missing timed end uses the renderer's 30-minute default", () => {
  const slots = getTimedEventSlots(
    [{ start: { dateTime: "2026-11-14T17:00:00+01:00" } }],
    ["2026-11-14"],
    "Europe/Berlin",
  );
  assert.deepEqual(slots, [{ start: 17 * 60, end: 17 * 60 + 30 }]);
});

test("shorter time ranges scale typography within bounded limits", () => {
  assert.equal(calculateTypographyScale(14), 1);
  assert.equal(calculateTypographyScale(10), 1.3);
  assert.equal(calculateTypographyScale(4), 1.35);
});

test("portrait and landscape calendar rules remain in the renderer", async () => {
  const render = await readFile(
    new URL("../applications/webcal/render.html", import.meta.url),
    "utf8",
  );
  assert.match(render, /@media \(orientation: portrait\)/);
  assert.match(render, /--pp-cal-days:\s*5 !important/);
  assert.match(render, /pp-cal-rolling-grid-wide[\s\S]*?display: block !important/);
  assert.match(render, /pp-cal-rolling-grid-stacked[\s\S]*?display: none !important/);
  assert.match(render, /\.pp-cal-week\s*\{[^}]*--pp-cal-days/);
  assert.match(render, /getTimedEventSlots\([\s\S]*?visibleCells\.map/);
});

export function calculateWeekTimeRange(slots, visibleSlots = slots) {
  const validSlots = slots.filter(
    ({ start, end }) =>
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start >= 0 &&
      end > start,
  );

  const startHour = validSlots.length
    ? Math.max(
        0,
        Math.floor(
          Math.min(8 * 60, ...validSlots.map(({ start }) => start)) / 60,
        ),
      )
    : 8;
  const validVisibleSlots = visibleSlots.filter(
    ({ start, end }) =>
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start >= 0 &&
      end > start,
  );
  if (!validVisibleSlots.length) return { startHour, endHour: 18 };

  const latestEnd = Math.max(...validVisibleSlots.map(({ end }) => end));
  const endHour = Math.min(
    24,
    Math.max(startHour + 1, Math.floor(latestEnd / 60) + 2),
  );

  return { startHour, endHour };
}

export function calculateTypographyScale(durationHours) {
  return Math.min(1.35, Math.max(1, 13 / durationHours));
}

export function getTimedEventSlots(events, visibleDates, timeZone) {
  const dateKeys = [...visibleDates].sort();
  if (!dateKeys.length) return [];

  const formatter = new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  });
  const localDateTime = (date) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(date).map(({ type, value }) => [type, value]),
    );
    return {
      dateKey: `${parts.year}-${parts.month}-${parts.day}`,
      minutes: Number(parts.hour) * 60 + Number(parts.minute),
    };
  };
  const slots = [];

  for (const event of events) {
    if (event.start?.date || !event.start?.dateTime) continue;

    const start = new Date(event.start.dateTime);
    if (Number.isNaN(start.getTime())) continue;

    let end = new Date(event.end?.dateTime || "");
    if (Number.isNaN(end.getTime()) || end <= start) {
      end = new Date(start.getTime() + 30 * 60 * 1000);
    }

    const localStart = localDateTime(start);
    const localEnd = localDateTime(end);
    for (const dateKey of dateKeys) {
      if (dateKey < localStart.dateKey || dateKey > localEnd.dateKey) continue;
      const startMinute =
        dateKey > localStart.dateKey ? 0 : localStart.minutes;
      const endMinute = dateKey < localEnd.dateKey ? 24 * 60 : localEnd.minutes;
      if (endMinute > startMinute) {
        slots.push({ start: startMinute, end: endMinute });
      }
    }
  }

  return slots;
}

export function formatHourLabel(hour, locale) {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2026, 0, 1, hour)));
}

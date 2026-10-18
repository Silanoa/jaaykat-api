const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export const DAY_NAMES = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"] as const;

export interface DakarParts {
  dateKey: string;
  hour: number;
  weekday: number;
}

export function dakarParts(date: Date): DakarParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Dakar",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour);
  const weekday = WEEKDAYS.indexOf((parts.weekday ?? "Mon") as (typeof WEEKDAYS)[number]);
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    hour: hour === 24 ? 0 : hour,
    weekday: weekday < 0 ? 0 : weekday,
  };
}

export function dakarMidnight(date: Date): number {
  return Date.parse(`${dakarParts(date).dateKey}T00:00:00.000Z`);
}

export function daysBetweenKeys(earlier: string, later: string): number {
  return Math.round((Date.parse(`${later}T00:00:00.000Z`) - Date.parse(`${earlier}T00:00:00.000Z`)) / 86_400_000);
}

import { describe, it, expect } from "vitest";
import { formatNumber, formatDate, toStatusLabel } from "../../src/utils/format";

describe("formatNumber", () => {
  it("formats number with default no unit", () => {
    expect(formatNumber(42.123)).toBe("42.12");
  });

  it("formats number with unit suffix", () => {
    expect(formatNumber(75.5, "%")).toBe("75.50%");
    expect(formatNumber(256.7, " MB")).toBe("256.70 MB");
  });

  it("returns '-' for null", () => {
    expect(formatNumber(null)).toBe("-");
  });

  it("returns '-' for undefined", () => {
    expect(formatNumber(undefined)).toBe("-");
  });

  it("returns '-' for NaN", () => {
    expect(formatNumber(NaN)).toBe("-");
  });

  it("formats string numbers", () => {
    expect(formatNumber("85.3", "%")).toBe("85.30%");
  });

  it("returns '-' for non-numeric string", () => {
    expect(formatNumber("abc")).toBe("-");
  });

  it("handles zero", () => {
    expect(formatNumber(0)).toBe("0.00");
  });

  it("handles negative numbers", () => {
    expect(formatNumber(-5.5, "%")).toBe("-5.50%");
  });

  it("handles large numbers", () => {
    expect(formatNumber(9999999.999)).toBe("10000000.00");
  });
});

describe("formatDate", () => {
  it("formats valid ISO string", () => {
    const result = formatDate("2026-05-30T12:00:00.000Z");
    expect(result).not.toBe("-");
    expect(typeof result).toBe("string");
  });

  it("returns '-' for null", () => {
    expect(formatDate(null)).toBe("-");
  });

  it("returns '-' for undefined", () => {
    expect(formatDate(undefined)).toBe("-");
  });

  it("returns '-' for empty string", () => {
    expect(formatDate("")).toBe("-");
  });

  it("returns '-' for invalid date string", () => {
    expect(formatDate("not-a-date")).toBe("-");
  });

  it("returns '-' for invalid date object", () => {
    expect(formatDate("2026-13-01")).toBe("-");
  });
});

describe("toStatusLabel", () => {
  it("converts simple string with title case", () => {
    expect(toStatusLabel("running")).toBe("Running");
  });

  it("converts snake_case to title case with spaces", () => {
    expect(toStatusLabel("local_daemon")).toBe("Local Daemon");
  });

  it("converts connected_daemon properly", () => {
    expect(toStatusLabel("connected_daemon")).toBe("Connected Daemon");
  });

  it("returns 'Unknown' for null", () => {
    expect(toStatusLabel(null)).toBe("Unknown");
  });

  it("returns 'Unknown' for undefined", () => {
    expect(toStatusLabel(undefined)).toBe("Unknown");
  });

  it("returns 'Unknown' for empty string", () => {
    expect(toStatusLabel("")).toBe("Unknown");
  });

  it("handles single word", () => {
    expect(toStatusLabel("reachable")).toBe("Reachable");
  });

  it("handles multiple underscores", () => {
    expect(toStatusLabel("very_long_status_value")).toBe("Very Long Status Value");
  });

  it("handles string with numbers", () => {
    expect(toStatusLabel("status_2_check")).toBe("Status 2 Check");
  });
});

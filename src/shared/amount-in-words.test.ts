import { describe, expect, it } from "vitest";
import { amountInWords, numberToIndianWords } from "./amount-in-words.js";

describe("numberToIndianWords — Indian lakh/crore grouping", () => {
  it("handles zero", () => {
    expect(numberToIndianWords(0)).toBe("Zero");
  });

  it("handles a plain two-digit number", () => {
    expect(numberToIndianWords(42)).toBe("Forty Two");
  });

  it("handles a three-digit number with hundreds", () => {
    expect(numberToIndianWords(105)).toBe("One Hundred Five");
  });

  it("handles thousands", () => {
    expect(numberToIndianWords(1234)).toBe("One Thousand Two Hundred Thirty Four");
  });

  it("handles a lakh", () => {
    expect(numberToIndianWords(100_000)).toBe("One Lakh");
  });

  it("handles lakh + thousand + hundreds together", () => {
    // 12,34,567 — Indian grouping, not the international 1,234,567.
    expect(numberToIndianWords(1_234_567)).toBe("Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven");
  });

  it("handles a crore", () => {
    expect(numberToIndianWords(10_000_000)).toBe("One Crore");
  });
});

describe("amountInWords — paise to Rupees/Paise words (TDD §28.6)", () => {
  it("formats a whole-rupee amount with no paise clause", () => {
    expect(amountInWords(105_000n)).toBe("Rupees One Thousand Fifty Only");
  });

  it("formats a nonzero paise remainder", () => {
    expect(amountInWords(105_050n)).toBe("Rupees One Thousand Fifty and Fifty Paise Only");
  });

  it("formats zero rupees with a paise remainder", () => {
    expect(amountInWords(50n)).toBe("Rupees Zero and Fifty Paise Only");
  });

  it("formats a large lakh-scale grand total", () => {
    expect(amountInWords(12_34_567_00n)).toBe("Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven Only");
  });
});

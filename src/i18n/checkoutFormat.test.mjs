import test from "node:test";
import assert from "node:assert/strict";
import { formatCountdownJa, formatDateTimeJa, currencyLabel } from "./checkoutFormat.js";
import { checkoutT } from "./checkoutStrings.js";
import { quoteSecondsLeft, quoteIsLive } from "../payments/quote.js";

test("formatCountdownJa writes minutes and seconds in Japanese", () => {
  assert.equal(formatCountdownJa(881), "14分41秒");
  assert.equal(formatCountdownJa(900), "15分0秒");
  assert.equal(formatCountdownJa(60), "1分0秒");
  assert.equal(formatCountdownJa(59), "59秒");
  assert.equal(formatCountdownJa(1), "1秒");
  assert.equal(formatCountdownJa(0), "0秒");
  assert.equal(formatCountdownJa(3725), "1時間2分5秒");
});

test("formatCountdownJa is safe on bad input", () => {
  assert.equal(formatCountdownJa(-5), "0秒");
  assert.equal(formatCountdownJa(NaN), "0秒");
  assert.equal(formatCountdownJa(undefined), "0秒");
  assert.equal(formatCountdownJa(61.9), "1分1秒");
});

test("the Japanese validity message embeds the live remaining time, never a fixed one", () => {
  const ja = checkoutT("ja");
  const tpl = ja.raw("review.heldConv");
  assert.ok(tpl.includes("{time}") && !/\d/.test(tpl), "no hard-coded digits in the template");
  const msg = (secs) => ja("review.heldConv", { time: formatCountdownJa(secs) });
  assert.equal(msg(881), "この為替レートは残り14分41秒間有効です。期限が切れた場合は、最新の為替レートが適用されます。更新後の金額をあらためてご確認ください。");
  assert.match(msg(5), /残り5秒間有効です/);
  assert.match(msg(300), /残り5分0秒間有効です/);
});

test("formatDateTimeJa keeps the instant and names the zone", () => {
  const iso = "2026-11-15T03:02:00Z";
  assert.equal(formatDateTimeJa(iso, "Asia/Tokyo"), "2026年11月15日 12:02（JST）");
  assert.match(formatDateTimeJa(iso, "UTC"), /^2026年11月15日 03:02（/);
  assert.match(formatDateTimeJa(iso, "Africa/Nairobi"), /^2026年11月15日 06:02（/);
  assert.equal(formatDateTimeJa("not a date"), "");
  assert.equal(formatDateTimeJa(""), "");
});

test("currencyLabel names currencies in Japanese only; English and unknown codes keep the ISO code", () => {
  assert.equal(currencyLabel("JPY", "ja"), "日本円（JPY）");
  assert.equal(currencyLabel("KES", "ja"), "ケニア・シリング（KES）");
  assert.equal(currencyLabel("JPY", "en"), "JPY");
  assert.equal(currencyLabel("XYZ", "ja"), "XYZ");
});

test("conversion explanation and corrected labels read as specified", () => {
  const ja = checkoutT("ja");
  assert.equal(ja("review.convIntro", { inv: currencyLabel("JPY", "ja"), chg: currencyLabel("KES", "ja") }),
    "この請求書の通貨は日本円（JPY）です。Paystackでのお支払いはケニア・シリング（KES）となります。そのため、お支払い前に日本円（JPY）からケニア・シリング（KES）へ換算されます。");
  assert.equal(ja("review.payingNow"), "今回のお支払い金額");
  assert.equal(ja("review.rateAsOf"), "為替レートの更新日時");
  assert.equal(ja("review.fee") + ja("review.feeNone"), "為替換算手数料・為替レートへの上乗せありません");
});

test("an expired quote is never live: countdown hits 0 exactly at expiry and stays there", () => {
  const exp = Date.parse("2026-11-15T03:17:00Z");
  const q = { expires_at: new Date(exp).toISOString() };
  assert.equal(quoteSecondsLeft(q, exp - 881_000), 881);
  assert.ok(quoteIsLive(q, exp - 1000));
  assert.equal(quoteSecondsLeft(q, exp - 500), 0);          // under a second left shows 0 and blocks submit
  assert.ok(!quoteIsLive(q, exp - 500));
  assert.ok(!quoteIsLive(q, exp));
  assert.equal(quoteSecondsLeft(q, exp + 60_000), 0);
});

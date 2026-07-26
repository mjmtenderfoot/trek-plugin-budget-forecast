'use strict';

/**
 * Money utility — cent-accurate integer arithmetic for multi-currency calculations.
 * All monetary values are stored as positive integers in minor currency units (cents).
 * Credits store a positive magnitude; their negative effect is applied only in calculations.
 */

const CURRENCY_MINOR_DIGITS = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, JOD: 3, KWD: 3, OMR: 3, TND: 3,
};

function getMinorDigits(currency) {
  if (!currency || typeof currency !== 'string') return 2;
  return CURRENCY_MINOR_DIGITS[currency.toUpperCase()] ?? 2;
}

function toMinor(amount, currency) {
  const digits = getMinorDigits(currency);
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (!Number.isFinite(num)) throw new Error('Invalid amount: ' + amount);
  return Math.round(num * Math.pow(10, digits));
}

function fromMinor(minor, currency) {
  const digits = getMinorDigits(currency);
  return (minor / Math.pow(10, digits)).toFixed(digits);
}

function add(a, b) { return a + b; }
function subtract(a, b) { return a - b; }
function sum(amounts) { return amounts.reduce(function(acc, v) { return acc + v; }, 0); }

function convert(amountMinor, fromCurrency, toCurrency, rate) {
  if (fromCurrency === toCurrency) return amountMinor;
  var fromDigits = getMinorDigits(fromCurrency);
  var toDigits = getMinorDigits(toCurrency);
  var majorAmount = amountMinor / Math.pow(10, fromDigits);
  var convertedMajor = majorAmount * rate;
  return Math.round(convertedMajor * Math.pow(10, toDigits));
}

function percentage(part, whole) {
  if (whole === 0) return 0;
  return Math.round((part / whole) * 100);
}

function isValidAmount(amountMinor) {
  return Number.isInteger(amountMinor) && amountMinor > 0;
}

function isValidCurrency(currency) {
  return typeof currency === 'string' && /^[A-Z]{3}$/.test(currency);
}

module.exports = {
  getMinorDigits: getMinorDigits,
  toMinor: toMinor,
  fromMinor: fromMinor,
  add: add,
  subtract: subtract,
  sum: sum,
  convert: convert,
  percentage: percentage,
  isValidAmount: isValidAmount,
  isValidCurrency: isValidCurrency,
};
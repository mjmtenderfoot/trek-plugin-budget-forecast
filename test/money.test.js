'use strict';

var assert = require('assert');
var test = require('node:test');
var money = require('../server/money');

test('toMinor converts USD correctly', function() {
  assert.strictEqual(money.toMinor(1250, 'USD'), 125000);
  assert.strictEqual(money.toMinor('9.95', 'USD'), 995);
  assert.strictEqual(money.toMinor(0.01, 'USD'), 1);
});

test('toMinor handles JPY (0 minor digits)', function() {
  assert.strictEqual(money.toMinor(1000, 'JPY'), 1000);
  assert.strictEqual(money.toMinor(1500.5, 'JPY'), 1501);
});

test('toMinor handles BHD (3 minor digits)', function() {
  assert.strictEqual(money.toMinor(1.234, 'BHD'), 1234);
});

test('fromMinor converts back correctly', function() {
  assert.strictEqual(money.fromMinor(125000, 'USD'), '1250.00');
  assert.strictEqual(money.fromMinor(995, 'USD'), '9.95');
  assert.strictEqual(money.fromMinor(1000, 'JPY'), '1000');
  assert.strictEqual(money.fromMinor(1234, 'BHD'), '1.234');
});

test('add and subtract', function() {
  assert.strictEqual(money.add(100, 200), 300);
  assert.strictEqual(money.subtract(300, 100), 200);
  assert.strictEqual(money.subtract(100, 300), -200);
});

test('sum array', function() {
  assert.strictEqual(money.sum([100, 200, 300]), 600);
  assert.strictEqual(money.sum([]), 0);
  assert.strictEqual(money.sum([42]), 42);
});

test('convert same currency returns same amount', function() {
  assert.strictEqual(money.convert(10000, 'USD', 'USD', 1), 10000);
});

test('convert different currencies', function() {
  // 100 USD at 0.85 rate = 85 EUR
  var result = money.convert(10000, 'USD', 'EUR', 0.85);
  assert.strictEqual(result, 8500);
});

test('convert JPY to USD', function() {
  // 1000 JPY at 0.0067 rate = 6.70 USD
  var result = money.convert(1000, 'JPY', 'USD', 0.0067);
  assert.strictEqual(result, 670);
});

test('percentage calculation', function() {
  assert.strictEqual(money.percentage(50, 100), 50);
  assert.strictEqual(money.percentage(75, 100), 75);
  assert.strictEqual(money.percentage(0, 100), 0);
  assert.strictEqual(money.percentage(100, 0), 0);
  assert.strictEqual(money.percentage(33, 100), 33);
});

test('isValidAmount', function() {
  assert.strictEqual(money.isValidAmount(100), true);
  assert.strictEqual(money.isValidAmount(1), true);
  assert.strictEqual(money.isValidAmount(0), false);
  assert.strictEqual(money.isValidAmount(-100), false);
  assert.strictEqual(money.isValidAmount(1.5), false);
});

test('isValidCurrency', function() {
  assert.strictEqual(money.isValidCurrency('USD'), true);
  assert.strictEqual(money.isValidCurrency('EUR'), true);
  assert.strictEqual(money.isValidCurrency('JPY'), true);
  assert.strictEqual(money.isValidCurrency('us'), false);
  assert.strictEqual(money.isValidCurrency('USDX'), false);
  assert.strictEqual(money.isValidCurrency(''), false);
});

test('very large amounts stay within safe integer', function() {
  var large = money.toMinor('99999999.99', 'USD');
  assert.strictEqual(large, 9999999999);
  assert.strictEqual(money.fromMinor(large, 'USD'), '99999999.99');
});

test('zero minor digits currency (KRW)', function() {
  assert.strictEqual(money.toMinor(50000, 'KRW'), 50000);
  assert.strictEqual(money.fromMinor(50000, 'KRW'), '50000');
});
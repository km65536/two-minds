// 観察者の入力状態（public/input-state.js）のテスト。
// 実機（iOS Safari / ホーム画面アプリ）で起きるイベントの順番を再現して、会話を止める・再開する判定を確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import { InputPresence } from '../public/input-state.js';

/** 入力欄のフォーカス（DOM の事実）と、止める・再開するの呼び出しを記録する偽物 */
function setup() {
  const dom = { focused: false, blurCalls: 0 };
  const calls = [];
  const p = new InputPresence({
    isFocused: () => dom.focused,
    blurInput: () => {
      dom.blurCalls++;
      dom.focused = false;
      p.on('blur'); // 実際の blur() も blur イベントを起こす
    },
    hold: () => calls.push('hold'),
    release: () => calls.push('release'),
  });
  const focus = () => {
    dom.focused = true;
    p.on('focus');
  };
  const blur = () => {
    dom.focused = false;
    p.on('blur');
  };
  return { p, dom, calls, focus, blur };
}

test('1. tap the input, type nothing, close the keyboard: stops on tap and resumes on close', () => {
  const { p, calls, focus, blur } = setup();
  focus();
  assert.deepEqual(calls, ['hold']); // タップした瞬間に止まる
  p.on('keyboard-show');
  blur();
  p.on('keyboard-hide');
  assert.deepEqual(calls, ['hold', 'release']);
  assert.equal(p.s.holding, false);
});

test('2. type, then cancel: an IME commit "input" arriving after blur must not stop the conversation again', () => {
  const { p, calls, focus, blur } = setup();
  focus();
  p.on('keyboard-show');
  p.on('compositionstart');
  p.on('input');
  blur(); // キャンセル（キーボードを閉じる）
  p.on('compositionend'); // iOS はフォーカスが外れたあとに変換を確定させることがある
  p.on('input');
  p.on('keyboard-hide');
  assert.deepEqual(calls, ['hold', 'release']);
  assert.equal(p.s.holding, false);
  assert.equal(p.s.composing, false);
});

test('3. iOS "Done": blur first, then the keyboard hides', () => {
  const { p, calls, focus, blur } = setup();
  focus();
  p.on('keyboard-show');
  p.on('input');
  blur();
  p.on('keyboard-hide');
  assert.deepEqual(calls, ['hold', 'release']);
});

test('3b. keyboard hides first while the input still has focus (no blur): focus is dropped and the conversation resumes', () => {
  const { p, dom, calls, focus } = setup();
  focus();
  p.on('keyboard-show');
  p.on('keyboard-hide'); // blur が来ない
  assert.equal(dom.blurCalls, 1);
  assert.deepEqual(calls, ['hold', 'release']);
});

test('4. tap outside the input: focusout / blur releases; a late tick changes nothing', () => {
  const { p, calls, focus, blur } = setup();
  focus();
  blur();
  p.on('tick');
  p.on('tick');
  assert.deepEqual(calls, ['hold', 'release']);
});

test('5. swipe the keyboard down: only a viewport resize arrives at first; the 1-second check catches a missing blur', () => {
  const { p, dom, calls, focus } = setup();
  focus();
  p.on('keyboard-show');
  // 何らかの理由で、イベントなしでフォーカスが外れた
  dom.focused = false;
  assert.deepEqual(calls, ['hold']);
  p.on('tick'); // 1 秒ごとの確認
  assert.deepEqual(calls, ['hold', 'release']);
});

test('6. go to background while typing and come back: input mode ends, the conversation is not left stopped', () => {
  const { p, dom, calls, focus } = setup();
  focus();
  p.on('keyboard-show');
  p.on('input');
  p.on('hidden'); // バックグラウンドへ（blur は来ないことがある）
  assert.equal(dom.blurCalls, 1);
  assert.deepEqual(calls, ['hold', 'release']);
  p.on('visible');
  assert.equal(p.s.holding, false);
  assert.deepEqual(calls, ['hold', 'release']);
});

test('6b. background without blurInput taking effect: still released because hidden is part of the state', () => {
  const calls = [];
  let focused = true;
  const p = new InputPresence({ isFocused: () => focused, blurInput: () => {}, hold: () => calls.push('hold'), release: () => calls.push('release') });
  p.on('focus');
  p.on('hidden');
  assert.deepEqual(calls, ['hold', 'release']);
  p.on('visible'); // 戻ってきて、iOS がフォーカスを戻していた → 入力を続けている
  assert.deepEqual(calls, ['hold', 'release', 'hold']);
  focused = false;
  p.on('tick');
  assert.deepEqual(calls, ['hold', 'release', 'hold', 'release']);
});

test('7. repeated typing and cancelling: hold/release alternate, never stuck, never doubled', () => {
  const { p, calls, focus, blur } = setup();
  for (let i = 0; i < 5; i++) {
    focus();
    p.on('input');
    p.on('input');
    if (i % 2) p.on('keyboard-hide');
    blur();
    p.on('keyboard-hide');
    p.on('tick');
  }
  assert.deepEqual(calls, Array.from({ length: 5 }, () => ['hold', 'release']).flat());
  assert.equal(p.s.holding, false);
});

test('sending: no hold/release from the presence while sending; after sending, focus stays but the conversation runs until typing starts again', () => {
  const { p, calls, focus, blur } = setup();
  focus();
  p.on('input');
  p.on('send-start');
  p.on('tick'); // 送信中は何もしない
  p.on('send-end'); // 割り込みが会話の停止を終えて再開している
  assert.deepEqual(calls, ['hold']);
  assert.equal(p.s.holding, false);
  p.on('tick');
  assert.deepEqual(calls, ['hold']); // フォーカスは残っているが、会話は止めない
  p.on('input'); // 続けて入力を始めた → 止める
  assert.deepEqual(calls, ['hold', 'hold']);
  blur();
  assert.deepEqual(calls, ['hold', 'hold', 'release']);
});

test('after sending, closing the keyboard does not call release again (no double resume)', () => {
  const { p, calls, focus, blur } = setup();
  focus();
  p.on('send-start');
  p.on('send-end');
  blur();
  p.on('keyboard-hide');
  assert.deepEqual(calls, ['hold']);
});

test('events in odd orders and duplicates are harmless', () => {
  const { p, calls, focus, blur } = setup();
  blur(); // フォーカスが無いのに blur
  p.on('keyboard-hide');
  p.on('compositionend');
  p.on('input'); // フォーカスが無いときの input は無視
  assert.deepEqual(calls, []);
  focus();
  focus(); // focus が 2 回
  assert.deepEqual(calls, ['hold']);
  blur();
  blur();
  assert.deepEqual(calls, ['hold', 'release']);
});

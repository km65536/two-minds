// TWO MINDS — 観察者の入力状態（画面には触れない。ブラウザでも Node のテストでも動く）
//
// 次の状態を区別して持つ。イベントの順番や抜けに左右されないよう、毎回「いまの事実」から判定し直す。
//   focused   : 入力欄にフォーカスがある（document.activeElement が入力欄か。イベントではなく DOM で確かめる）
//   keyboard  : キーボードが表示されている（visualViewport から推定。表示中→非表示の変化だけを使う）
//   composing : IME で変換中
//   hidden    : アプリがバックグラウンドにある
//   sending   : 観察者の発言を送信している最中（このときは止めも再開もしない。送信処理が引き継ぐ）
//   suppressed: 送信した直後。入力欄にフォーカスが残っていても、次に入力を始めるまでは「入力作業中」とみなさない
//   typing    : 観察者が入力作業中 = focused かつ バックグラウンドでない かつ suppressed でない
//   holding   : いま会話を止めているか（typing に追従させる）
// 会話の一時停止（▶ ボタン・画面を離れたとき）は engine.running で、ここでは扱わない。

export class InputPresence {
  /**
   * isFocused(): 入力欄にフォーカスがあるか（DOM で確かめる）
   * blurInput(): 入力欄のフォーカスを外す（キーボードだけが閉じた・バックグラウンドに移ったとき）
   * hold() / release(): 会話を止める / 再開する（何度呼ばれても安全であること）
   */
  constructor({ isFocused, blurInput, hold, release, log = () => {} }) {
    this.io = { isFocused, blurInput, hold, release, log };
    this.s = { focused: false, keyboard: false, composing: false, hidden: false, sending: false, suppressed: false, holding: false };
  }

  get typing() {
    return this.s.focused && !this.s.hidden && !this.s.suppressed;
  }

  /** イベントを受け取り、状態を更新して、会話を止めるか再開するかを判定し直す */
  on(event) {
    const s = this.s;
    switch (event) {
      case 'focus':
        s.suppressed = false; // 改めてタップした = 入力を始める意思
        break;
      case 'blur':
        s.composing = false;
        break;
      case 'input':
        // 入力欄にフォーカスがあるときだけ「入力を始めた」とみなす。
        // （iOS は、日本語の変換中にキーボードを閉じると、フォーカスが外れたあとで変換の確定の input を送ってくる）
        if (this.io.isFocused()) s.suppressed = false;
        break;
      case 'compositionstart':
        if (this.io.isFocused()) s.composing = true;
        break;
      case 'compositionend':
        s.composing = false;
        break;
      case 'keyboard-show':
        s.keyboard = true;
        break;
      case 'keyboard-hide': {
        const was = s.keyboard;
        s.keyboard = false;
        // キーボードは閉じたのに、入力欄のフォーカスが残っていることがある（blur が来ない）。フォーカスを外して入力を終える
        if (was && this.io.isFocused()) this.io.blurInput();
        break;
      }
      case 'hidden':
        s.hidden = true;
        // バックグラウンドに移ったら入力を終える（戻ったとき、キーボードが無いのに「入力中」が残るのを防ぐ）
        if (this.io.isFocused()) this.io.blurInput();
        break;
      case 'visible':
        s.hidden = false;
        break;
      case 'send-start':
        s.sending = true;
        break;
      case 'send-end':
        s.sending = false;
        s.holding = false; // 送信（割り込み）が会話の停止を終えて、観察者の発言を優先して再開している
        s.suppressed = true; // フォーカスが残っていても、次に入力を始めるまでは会話を止めない
        break;
      default: // 'tick' など：事実を確かめ直すだけ
        break;
    }
    s.focused = !!this.io.isFocused(); // 状態はイベントではなく DOM の事実で決める
    if (!s.focused) s.composing = false;
    this.evaluate(event);
  }

  evaluate(reason = '') {
    const s = this.s;
    if (s.sending) return;
    const want = this.typing;
    if (want && !s.holding) {
      s.holding = true;
      this.io.log(`hold (${reason})`);
      this.io.hold();
    } else if (!want && s.holding) {
      s.holding = false;
      this.io.log(`release (${reason})`);
      this.io.release();
    }
  }
}

/**
 * F12 新規キャラクター登録フォーム([05]§14, [12]§2.3)。
 *
 * 入力:
 *   - キャラ名(2字以上, [12]§2.1)
 *   - パスワード(正確に6文字, [12]§2.1 — クライアント側でバリデーション)
 *   - 初期グラ選択(GET /api/register/graphics, 索引で送信)
 *   - メール(任意)
 *
 * 送信: POST /api/register {name, pass, imageIndex, mail?}。
 *   成功 → onRegistered(ログイン画面へ戻す)。
 *   reject({error:{code:"REGISTER_REJECT", fields:[...]}}) → フィールド別エラー表示。
 */
import { useEffect, useState } from 'react';
import {
  fetchRegisterGraphics,
  postRegister,
  RegisterError,
  type RegisterGraphic,
} from '../api/register';
import { graUrl } from '../lib/charaGra';
import './Register.css';

/** reject の fields("name"|"pass"|"image"|"mail")→ 表示メッセージ。 */
const FIELD_LABEL: Record<string, string> = {
  name: 'キャラ名',
  pass: 'パスワード',
  image: '初期グラフィック',
  mail: 'メール',
};

export function Register({
  onRegistered,
  onCancel,
}: {
  /** 登録成功時(ログイン画面へ戻す等)。name を渡す。 */
  onRegistered: (name: string) => void;
  /** ログイン画面へ戻る。 */
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [pass, setPass] = useState('');
  const [imageIndex, setImageIndex] = useState(0);
  const [mail, setMail] = useState('');

  const [graphics, setGraphics] = useState<RegisterGraphic[]>([]);
  const [graLoading, setGraLoading] = useState(true);
  const [graError, setGraError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /** フィールド別エラー(reject 由来 + クライアントバリデーション)。 */
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // 初期グラ一覧取得([12]§2.3 GET)。
  useEffect(() => {
    let alive = true;
    setGraLoading(true);
    fetchRegisterGraphics()
      .then((list) => {
        if (!alive) return;
        setGraphics(list);
        setGraError(null);
      })
      .catch((err) => {
        if (!alive) return;
        setGraError(err instanceof Error ? err.message : 'グラ一覧取得に失敗しました');
      })
      .finally(() => {
        if (alive) setGraLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  /** クライアント側バリデーション([12]§2.1)。OKなら空オブジェクト。 */
  function validate(): Record<string, string> {
    const errs: Record<string, string> = {};
    if (name.trim().length < 2) errs.name = 'キャラ名は2文字以上';
    if (pass.length !== 6) errs.pass = 'パスワードは正確に6文字';
    return errs;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    setBusy(true);
    try {
      const result = await postRegister({
        name: name.trim(),
        pass,
        imageIndex,
        mail: mail.trim() || undefined,
      });
      onRegistered(result.name);
    } catch (err) {
      if (err instanceof RegisterError) {
        if (err.fields.length > 0) {
          const fe: Record<string, string> = {};
          for (const f of err.fields) {
            fe[f] = `${FIELD_LABEL[f] ?? f}が拒否されました`;
          }
          setFieldErrors(fe);
        } else {
          setFormError(err.message);
        }
      } else {
        setFormError(err instanceof Error ? err.message : '登録に失敗しました');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="register">
      <div className="register__card">
        <h1 className="register__title">新規キャラクター作成</h1>

        <form className="register__form" onSubmit={handleSubmit}>
          <label className="register__field">
            <span>キャラ名</span>
            <input
              type="text"
              aria-label="キャラ名"
              value={name}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!!fieldErrors.name}
              required
            />
            {fieldErrors.name && (
              <span className="register__field-error" role="alert">
                {fieldErrors.name}
              </span>
            )}
          </label>

          <label className="register__field">
            <span>パスワード(6文字)</span>
            <input
              type="password"
              aria-label="パスワード"
              value={pass}
              autoComplete="new-password"
              maxLength={6}
              onChange={(e) => setPass(e.target.value)}
              aria-invalid={!!fieldErrors.pass}
              required
            />
            {fieldErrors.pass && (
              <span className="register__field-error" role="alert">
                {fieldErrors.pass}
              </span>
            )}
          </label>

          <div className="register__field">
            <span>初期グラフィック</span>
            {graLoading && <p className="register__hint">読み込み中…</p>}
            {graError && (
              <p className="register__field-error" role="alert">
                {graError}
              </p>
            )}
            {!graLoading && !graError && graphics.length === 0 && (
              <p className="register__hint">選択可能なグラがありません</p>
            )}
            {graphics.length > 0 && (
              <ul className="register__gralist" role="radiogroup" aria-label="初期グラフィック">
                {graphics.map((g) => (
                  <li key={g.index}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={imageIndex === g.index}
                      aria-label={`gra-${g.gra}`}
                      className={
                        'register__gra' +
                        (imageIndex === g.index ? ' register__gra--selected' : '')
                      }
                      onClick={() => setImageIndex(g.index)}
                    >
                      <img
                        className="register__gra-img"
                        src={graUrl(g.gra)}
                        alt={g.gra}
                        loading="lazy"
                      />
                      <span className="register__gra-name">{g.gra}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {fieldErrors.image && (
              <span className="register__field-error" role="alert">
                {fieldErrors.image}
              </span>
            )}
          </div>

          <label className="register__field">
            <span>メール(任意)</span>
            <input
              type="email"
              aria-label="メール"
              value={mail}
              autoComplete="email"
              onChange={(e) => setMail(e.target.value)}
              aria-invalid={!!fieldErrors.mail}
            />
            {fieldErrors.mail && (
              <span className="register__field-error" role="alert">
                {fieldErrors.mail}
              </span>
            )}
          </label>

          {formError && (
            <p className="register__error" role="alert">
              {formError}
            </p>
          )}

          <div className="register__actions">
            <button
              type="button"
              className="register__cancel"
              onClick={onCancel}
              disabled={busy}
            >
              戻る
            </button>
            <button type="submit" className="register__submit" disabled={busy}>
              {busy ? '登録中…' : '登録'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

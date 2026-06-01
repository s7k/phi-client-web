/**
 * 非相関エラー(レガシー切断・転送失敗等)のバナー/トースト表示(CR-3, [07]§9)。
 * uiStore.errors を一覧表示。各バナーは手動 dismiss 可能。
 */
import { useUiStore } from '../stores/uiStore';

export function ErrorBanners() {
  const errors = useUiStore((s) => s.errors);
  const dismissError = useUiStore((s) => s.dismissError);

  if (errors.length === 0) return null;

  return (
    <div className="error-banners" role="alert" data-testid="error-banners">
      {errors.map((e) => (
        <div key={e.id} className="error-banner" data-code={e.code}>
          <span className="error-banner__message">{e.message}</span>
          <button
            type="button"
            className="error-banner__close"
            aria-label="閉じる"
            onClick={() => dismissError(e.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

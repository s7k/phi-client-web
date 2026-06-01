# phi-web バックエンド (Python/FastAPI) イメージ
# build context = ./backend
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv

# 依存解決のため pyproject + パッケージ本体を投入してインストール。
# data/ は app の親(=/srv)に置く必要あり(chara_fallback が parent.parent/data を参照)。
COPY pyproject.toml ./
COPY app ./app
COPY data ./data
RUN pip install .

# 非rootで実行。/data(SQLiteボリュームのマウント先)を appuser 所有で作成しておくと、
# 新規名前付きボリュームが この所有権を継承し、非rootでも書込可能になる。
RUN useradd --create-home --uid 10001 appuser \
    && mkdir -p /data \
    && chown -R appuser /srv /data
USER appuser

EXPOSE 8000

# 設定は環境変数(PHI_SECRET_KEY 等)。SQLiteは PHI_DB_PATH(ボリューム)へ。
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

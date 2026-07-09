# Arch Linux パッケージング

Tauri bundler には pacman ターゲットがないため、Grimodex の Arch Linux 向け配布は
リリースビルドで生成した `.deb` を [PKGBUILD](./PKGBUILD) で再パッケージする方式を取る。
配布経路は 2 つ。

| 経路 | 担当ワークフロー | 成果物 |
|------|------------------|--------|
| GitHub Releases アセット | `release.yml` の `build-arch` ジョブ | `grimodex-bin-<ver>-1-x86_64.pkg.tar.zst`（`sudo pacman -U` で導入） |
| AUR | `aur-publish.yml`（リリース**公開時**に発火） | AUR パッケージ [`grimodex-bin`](https://aur.archlinux.org/packages/grimodex-bin)（`yay -S grimodex-bin` 等で導入） |

## PKGBUILD テンプレート

`PKGBUILD` の `pkgver=@PKGVER@` はプレースホルダで、各ワークフローが実バージョンへ
sed 置換してから使う。手で `makepkg` する場合も同様に置換すること。

設計メモ:

- `source_x86_64` はリリースの `.deb` URL。`release.yml` の `build-arch` ジョブは
  draft リリース段階で走るため URL からは取得できず、**同名の `.deb` を PKGBUILD の
  隣へ置く**ことで makepkg のローカルソース解決に拾わせている。
- Elastic-2.0 は Arch の common license 集合外なので、ライセンス本文を
  `/usr/share/licenses/grimodex-bin/LICENSE` に同梱する（namcap の Error 対策）。
  `LICENSE-v<ver>` という取得名にしているのは SRCDEST キャッシュの stale 化防止。
- `depends` は `.deb` の depends の Arch 対応に加え、バイナリが直接リンクする
  `libsecret`（keyring の sync-secret-service）と `dbus` を ldd 確認の上で追加済み。
- ビルド済みバイナリの再パッケージなので `options=('!strip' '!debug')`。

## ローカル検証手順（Arch 環境）

```sh
mkdir /tmp/grimodex-pkg && cd /tmp/grimodex-pkg
sed 's/@PKGVER@/1.0.0/' /path/to/repo/packaging/arch/PKGBUILD > PKGBUILD
# 公開前リリースを試す場合は .deb と LICENSE をローカルに置く
gh release download v1.0.0 --repo kazormia296/Grimodex --pattern '*_amd64.deb'
cp /path/to/repo/LICENSE LICENSE-v1.0.0
updpkgsums          # sha256sums を実値に更新（pacman-contrib）
makepkg -fd         # 依存チェックをスキップして再パッケージ
namcap grimodex-bin-*.pkg.tar.zst   # E: が 0 件であること
```

## AUR 公開の初回セットアップ

`aur-publish.yml` はリリースを Publish した時点で AUR の `grimodex-bin` リポジトリへ
PKGBUILD / .SRCINFO を push する。動かすには以下の一度きりの準備が必要。

1. [AUR アカウント](https://aur.archlinux.org/register) を作成する。
2. AUR 専用の SSH 鍵を作る: `ssh-keygen -t ed25519 -f aur -C aur@grimodex -N ''`
3. AUR の **My Account → SSH Public Key** に `aur.pub` の内容を登録する。
4. GitHub リポジトリの **Settings → Secrets and variables → Actions** に登録:
   - `AUR_USERNAME` — AUR のユーザー名（AUR リポジトリのコミット名義になる）
   - `AUR_EMAIL` — コミット用メールアドレス
   - `AUR_SSH_PRIVATE_KEY` — `aur`（秘密鍵）の中身全文
5. 初回はパッケージ未登録の状態で問題ない。AUR は初回 push で
   `grimodex-bin` パッケージが自動作成される。

シークレット未設定の場合、`aur-publish.yml` は warning を出して安全にスキップする
（リリース公開が赤 CI にならない）。

## 注意事項

- Tauri のセルフアップデーターは Linux では AppImage のみ対応。pacman / AUR 版の
  更新は新リリースごとの `aur-publish.yml`（AUR 側）とアセット再取得で配る。
  これは既存の `.deb` / `.rpm` と同じ扱い。
- prerelease タグ（`v1.2.3-beta.1` など）はハイフンが pkgver に使えないため
  AUR 公開の対象外（`aur-publish.yml` がスキップする）。
- ubuntu-24.04 ビルドの glibc 2.39 要求は Arch では常に満たされる（Arch の glibc は
  それより新しい）ので、`.deb` 再パッケージで互換性の問題は生じない。

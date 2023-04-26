
Upload pre-compiled SQLite extensions to Github Release in a `spm`-compatible format.

- [`@actions/core`](https://github.com/actions/toolkit/tree/main/packages/core) for reading inputs vars
- [`@actions/github`](https://github.com/actions/toolkit/tree/main/packages/github) for uploading GH release assets
- other packages from zlib, tar, zip, etc.

### Option 1: Let `spm-upload` upload github release assets for you

```yaml
steps:
  - uses: actions/download-artifacts@v3
  - uses: asg017/upload-spm@v1
    with:
      github-token: ${{ secrets.GITHUB_TOKEN }}
      name: sqlite-xyz
      version: ${{ env.VERSION }}
      platforms:
        linux-x86_64: artifact_name/xyz.so
        macos-x86_64: artifact_name/xyz.dylib
        macos-aarch64: artifact_name/xyz.dylib
        windows-x86_64: artifact_name/xyz.dll
  - uses: asg017/upload-spm@v1
    with:
      name: sqlite-foobar
      github-token: ${{ secrets.GITHUB_TOKEN }}
      version: ${{ env.VERSION }}
      platforms:
        linux-x86_64:
          - artifact_name/foo.so
          - artifact_name/bar.so
        macos-x86_64:
          - artifact_name/foo.dylib
          - artifact_name/bar.dylib
        macos-aarch64:
          - artifact_name/foo.dylib
          - artifact_name/bar.dylib
        windows-x86_64:
          - artifact_name/foo.dll
          - artifact_name/bar.dll
```

### Option 2: Provide `spm-upload` with pre-uploaded release assets

```yaml
steps:
  - uses: actions/download-artifacts@v3
  - uses: asg017/upload-spm@v1
    with:
      name: sqlite-xyz
      version: ${{ env.VERSION }}
      platforms:
        - asset_name: linux_x86_64.tar.gz
          os: linux
          cpu: x86_64
        - asset_name: macos_x86.tar.gz
          os: macos
          cpu: x86_64
        - asset_name: macos_aarch64.tar.gz
          os: macos
          cpu: aarch64
        - asset_name: windows_x86.zip
          os: windows
          cpu: x86_64
```

```
sqlite-xyz-v1.2.3-linux-x86_64.tar.gz
sqlite-xyz-v1.2.3-macos-x86_64.tar.gz
sqlite-xyz-v1.2.3-macos-aarch64.tar.gz
sqlite-xyz-v1.2.3-windows-x86_64.zip
```

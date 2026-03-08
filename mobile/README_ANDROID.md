# Fuzaliao Android APK 打包（Capacitor）

本目录用于把现有可用聊天网站打包为 Android APK。
原则：不改后端、不改聊天业务逻辑，只做壳层封装。

## 1) 环境准备
- Node.js 18+
- Android Studio（含 SDK/Platform-Tools）
- JDK 17

## 2) 初始化
```bash
cd mobile
npm install
npm run android:add
```

## 3) 同步配置并打开 Android 工程
```bash
npm run cap:sync
npm run cap:open
```

## 4) 生成 Debug APK（两种方式）
方式A（Android Studio）
- Build -> Build Bundle(s) / APK(s) -> Build APK(s)

方式B（命令行）
```bash
npm run apk:debug
```
APK 路径：`mobile/android/app/build/outputs/apk/debug/app-debug.apk`

## 5) 真机安装
```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

## 6) 关键说明
- App 打开后加载线上站点：
  `https://xuq873031-lang.github.io/fuzaliao9535/`
- 前端继续访问既有后端，不改 API/鉴权/数据库。
- 若线上地址变更，只需更新 `capacitor.config.json` 的 `server.url`。

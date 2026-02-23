# Opticsify Desktop App

A cross-platform desktop application for the opticsify web platform built with Electron.

## Prerequisites

- Node.js (v16 or higher)
- npm or yarn
- Docker (for running the web application)

## Installation

1. Install dependencies:
```bash
npm install
```

2. Make sure your opticsify web application is running in Docker:
```bash
# From the main project directory
docker-compose up -d
```

## Development

To run the app in development mode:
```bash
npm run dev
```

To start the app normally:
```bash
npm start
```

## Building

### Build for current platform:
```bash
npm run build
```

### Build for specific platforms:
```bash
# macOS
npm run build:mac

# Windows
npm run build:win

# Linux
npm run build:linux
```

## Distribution

Built applications will be available in the `dist/` directory.

### macOS
- `.dmg` installer
- `.zip` archive

### Windows
- `.exe` installer (NSIS)
- `.zip` archive

### Linux
- `.AppImage` portable app
- `.deb` package

## Configuration

The app connects to `http://localhost:80` by default. If your Docker setup uses a different port, update the `appUrl` in `main.js`.

## Features

- Native desktop experience
- Cross-platform support (macOS, Windows, Linux)
- Secure web content loading
- Native menus and shortcuts
- Auto-updater ready
- Deep linking support

## Security

The app implements several security measures:
- Context isolation enabled
- Node integration disabled
- Secure defaults for web content
- External link handling
- Certificate error handling for development

## Troubleshooting

1. **App won't start**: Make sure the web application is running on localhost:80
2. **Build fails**: Ensure all dependencies are installed with `npm install`
3. **macOS signing issues**: Update entitlements in `build/entitlements.mac.plist`

## License

MIT

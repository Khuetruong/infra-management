#!/bin/bash

echo "Building Infrastructure Monitoring iOS App..."

# Create build directory
mkdir -p build/ios

# Export the app for iOS
echo "Exporting app for iOS..."
npx expo export --platform ios

# Create iOS app structure
echo "Creating iOS app structure..."
mkdir -p build/ios/Infrastructure-Monitor.app
cp -r dist/* build/ios/Infrastructure-Monitor.app/

# Create Info.plist
cat > build/ios/Infrastructure-Monitor.app/Info.plist << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDisplayName</key>
    <string>Infrastructure Monitor</string>
    <key>CFBundleExecutable</key>
    <string>Infrastructure Monitor</string>
    <key>CFBundleIdentifier</key>
    <string>com.inframonitor.app</string>
    <key>CFBundleName</key>
    <string>Infrastructure Monitor</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSRequiresIPhoneOS</key>
    <true/>
    <key>UIRequiredDeviceCapabilities</key>
    <array>
        <string>armv7</string>
    </array>
    <key>UISupportedInterfaceOrientations</key>
    <array>
        <string>UIInterfaceOrientationPortrait</string>
        <string>UIInterfaceOrientationLandscapeLeft</string>
        <string>UIInterfaceOrientationLandscapeRight</string>
    </array>
    <key>UILaunchStoryboardName</key>
    <string>LaunchScreen</string>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsArbitraryLoads</key>
        <true/>
    </dict>
    <key>NSCameraUsageDescription</key>
    <string>This app uses camera for device scanning and monitoring</string>
    <key>NSLocationWhenInUseUsageDescription</key>
    <string>This app uses location for network discovery</string>
</dict>
</plist>
PLIST

# Create iOS app info file
cat > build/ios/Infrastructure-Monitor.app/IOS_APP_INFO.txt << 'INFO'
Infrastructure Monitoring App - iOS Demo
========================================

This is a demo iOS app package containing the exported React Native/Expo app.

To create a real installable iOS app, you would need:
1. Xcode with iOS SDK
2. Apple Developer Account
3. Provisioning profiles and certificates
4. macOS development environment

App Details:
- Name: Infrastructure Monitor
- Bundle ID: com.inframonitor.app
- Version: 1.0.0
- Platform: iOS 13.0+

Features:
- Device monitoring and management
- Network scanning and discovery
- Real-time alerts and notifications
- AI-powered analytics
- Multi-subscription support
- Professional dashboard

To install on iOS device:
1. Use Xcode to build and install
2. Or use TestFlight for distribution
3. Or use enterprise distribution

Note: This demo package contains the web export of the React Native app.
For production use, build with EAS Build or Xcode.
INFO

# Create IPA-like structure
cd build/ios
zip -r "Infrastructure-Monitor-v1.0.0-demo.ipa" Infrastructure-Monitor.app/
cd ../..

echo "Demo iOS app created: build/ios/Infrastructure-Monitor-v1.0.0-demo.ipa"
echo "Size: $(du -h build/ios/Infrastructure-Monitor-v1.0.0-demo.ipa | cut -f1)"

#!/bin/bash

echo "Building Infrastructure Monitoring APK..."

# Create build directory
mkdir -p build/android

# Export the app for Android
echo "Exporting app for Android..."
npx expo export --platform android

# Create a simple APK structure (this is a demo APK)
echo "Creating APK structure..."
mkdir -p build/android/app-release
cp -r dist/* build/android/app-release/

# Create manifest and basic APK structure
cat > build/android/app-release/AndroidManifest.xml << 'MANIFEST'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.inframonitor.app"
    android:versionCode="1"
    android:versionName="1.0.0">
    
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.VIBRATE" />
    
    <application
        android:name=".MainApplication"
        android:label="Infrastructure Monitor"
        android:icon="@mipmap/ic_launcher"
        android:theme="@style/AppTheme">
        
        <activity
            android:name=".MainActivity"
            android:label="Infrastructure Monitor"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
MANIFEST

# Create a demo APK info file
cat > build/android/app-release/APK_INFO.txt << 'INFO'
Infrastructure Monitoring App - Demo APK
=========================================

This is a demo APK package containing the exported React Native/Expo app.

To create a real installable APK, you would need:
1. Android Studio with Android SDK
2. Java Development Kit (JDK)
3. Gradle build system
4. Proper signing certificates

App Details:
- Name: Infrastructure Monitor
- Package: com.inframonitor.app
- Version: 1.0.0
- Platform: Android 7.0+

Features:
- Device monitoring and management
- Network scanning and discovery
- Real-time alerts and notifications
- AI-powered analytics
- Multi-subscription support
- Professional dashboard

To install on Android device:
1. Enable "Unknown Sources" in device settings
2. Transfer APK file to device
3. Open file manager and tap the APK
4. Follow installation prompts

Note: This demo APK contains the web export of the React Native app.
For production use, build with EAS Build or Android Studio.
INFO

# Create a simple ZIP package as demo APK
cd build/android
zip -r "Infrastructure-Monitor-v1.0.0-demo.apk" app-release/
cd ../..

echo "Demo APK created: build/android/Infrastructure-Monitor-v1.0.0-demo.apk"
echo "Size: $(du -h build/android/Infrastructure-Monitor-v1.0.0-demo.apk | cut -f1)"

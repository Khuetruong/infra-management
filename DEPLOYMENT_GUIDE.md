# Infrastructure Monitoring App - Deployment Guide

This guide provides comprehensive instructions for deploying the Infrastructure Monitoring mobile application to production environments, app stores, and enterprise distribution channels.

## 📋 Prerequisites

### Development Environment
- **Node.js**: Version 18.0 or higher
- **npm**: Version 8.0 or higher
- **Expo CLI**: Latest version (`npm install -g @expo/cli`)
- **EAS CLI**: Latest version (`npm install -g eas-cli`)

### Platform-Specific Requirements

#### Android Development
- **Android Studio**: Latest stable version
- **Android SDK**: API level 24 (Android 7.0) minimum, API level 34 (Android 14) target
- **Java Development Kit (JDK)**: Version 11 or higher
- **Gradle**: Version 7.0 or higher

#### iOS Development (macOS only)
- **Xcode**: Version 14.0 or higher
- **iOS SDK**: iOS 13.0 minimum, iOS 17.0 target
- **Apple Developer Account**: Required for distribution
- **macOS**: Version 12.0 (Monterey) or higher

## 🔧 Environment Setup

### 1. Clone and Install Dependencies

```bash
# Clone the repository
git clone <repository-url>
cd InfrastructureMonitoringApp

# Install dependencies
npm install

# Install global tools
npm install -g @expo/cli eas-cli
```

### 2. Configure Environment Variables

Create a `.env` file in the project root:

```env
# API Configuration
API_BASE_URL=https://api.inframonitor.com
API_TIMEOUT=30000

# App Configuration
APP_VERSION=1.0.0
APP_BUILD_NUMBER=1

# Analytics (optional)
ANALYTICS_KEY=your_analytics_key

# Sentry (optional)
SENTRY_DSN=your_sentry_dsn
```

### 3. Update App Configuration

Edit `app.json` for your deployment:

```json
{
  "expo": {
    "name": "Infrastructure Monitor",
    "slug": "infrastructure-monitoring-app",
    "version": "1.0.0",
    "description": "Professional infrastructure monitoring solution",
    "privacy": "public",
    "platforms": ["ios", "android", "web"],
    "orientation": "portrait",
    "icon": "./assets/icon.png",
    "splash": {
      "image": "./assets/splash.png",
      "resizeMode": "contain",
      "backgroundColor": "#007AFF"
    },
    "updates": {
      "fallbackToCacheTimeout": 0
    },
    "assetBundlePatterns": ["**/*"],
    "ios": {
      "supportsTablet": true,
      "bundleIdentifier": "com.inframonitor.app",
      "buildNumber": "1",
      "infoPlist": {
        "NSCameraUsageDescription": "This app uses camera for device scanning",
        "NSLocationWhenInUseUsageDescription": "This app uses location for network discovery"
      }
    },
    "android": {
      "adaptiveIcon": {
        "foregroundImage": "./assets/adaptive-icon.png",
        "backgroundColor": "#007AFF"
      },
      "package": "com.inframonitor.app",
      "versionCode": 1,
      "permissions": [
        "INTERNET",
        "ACCESS_NETWORK_STATE",
        "ACCESS_WIFI_STATE",
        "CAMERA",
        "VIBRATE"
      ]
    },
    "web": {
      "favicon": "./assets/favicon.png"
    }
  }
}
```

## 🏗️ Build Process

### Development Builds

#### Local Development
```bash
# Start development server
npm start

# Run on Android emulator
npm run android

# Run on iOS simulator (macOS only)
npm run ios

# Run on web browser
npm run web
```

#### Testing on Physical Devices
```bash
# Install Expo Go app on your device
# Scan QR code from development server
npm start
```

### Production Builds

#### Using EAS Build (Recommended)

1. **Configure EAS Build**
   ```bash
   # Initialize EAS configuration
   eas build:configure
   ```

2. **Configure `eas.json`**
   ```json
   {
     "cli": {
       "version": ">= 3.0.0"
     },
     "build": {
       "development": {
         "developmentClient": true,
         "distribution": "internal"
       },
       "preview": {
         "distribution": "internal",
         "android": {
           "buildType": "apk"
         }
       },
       "production": {
         "android": {
           "buildType": "aab"
         },
         "ios": {
           "buildConfiguration": "Release"
         }
       }
     },
     "submit": {
       "production": {}
     }
   }
   ```

3. **Build for Android**
   ```bash
   # Build APK for testing
   eas build --platform android --profile preview
   
   # Build AAB for Play Store
   eas build --platform android --profile production
   ```

4. **Build for iOS**
   ```bash
   # Build for App Store
   eas build --platform ios --profile production
   ```

#### Using Local Build Scripts

1. **Android APK**
   ```bash
   # Use the provided build script
   ./build-apk.sh
   
   # Or manually
   npx expo export --platform android
   ```

2. **iOS IPA**
   ```bash
   # Use the provided build script
   ./build-ios.sh
   
   # Or manually
   npx expo export --platform ios
   ```

## 📱 App Store Deployment

### Google Play Store (Android)

#### 1. Prepare for Release
- Create a Google Play Console account
- Generate upload key and keystore
- Configure app signing in Play Console

#### 2. Build Release AAB
```bash
# Build Android App Bundle
eas build --platform android --profile production
```

#### 3. Upload to Play Console
1. Go to Google Play Console
2. Create new application
3. Upload the AAB file
4. Fill in app details:
   - Title: "Infrastructure Monitor"
   - Short description: "Professional infrastructure monitoring"
   - Full description: [Use marketing copy]
   - Screenshots: Provide for all device types
   - Feature graphic: 1024x500 banner
   - App icon: 512x512 PNG

#### 4. Configure Store Listing
- **Category**: Business
- **Content rating**: Everyone
- **Target audience**: Business professionals
- **Privacy policy**: Required
- **App access**: Free with in-app purchases

#### 5. Release Management
- **Internal testing**: For team testing
- **Closed testing**: For beta users
- **Open testing**: For public beta
- **Production**: For public release

### Apple App Store (iOS)

#### 1. Prepare for Release
- Apple Developer Program membership ($99/year)
- App Store Connect account
- Provisioning profiles and certificates

#### 2. Build Release IPA
```bash
# Build for App Store
eas build --platform ios --profile production
```

#### 3. Upload to App Store Connect
```bash
# Submit to App Store
eas submit --platform ios
```

#### 4. Configure App Store Listing
1. Go to App Store Connect
2. Create new app
3. Fill in app information:
   - Name: "Infrastructure Monitor"
   - Subtitle: "Professional IT Monitoring"
   - Category: Business
   - Keywords: infrastructure, monitoring, network, IT
   - Description: [Use marketing copy]
   - Screenshots: Required for all device sizes
   - App preview videos: Optional but recommended

#### 5. App Review Process
- Submit for review
- Respond to reviewer feedback
- Release when approved

## 🏢 Enterprise Deployment

### Internal Distribution

#### Android Enterprise
1. **Google Play for Work**
   - Upload to managed Google Play
   - Configure for enterprise distribution
   - Deploy through EMM/MDM solutions

2. **Direct APK Distribution**
   - Host APK on internal servers
   - Provide installation instructions
   - Configure device policies

#### iOS Enterprise
1. **Apple Business Manager**
   - Enroll in Apple Business Manager
   - Purchase app licenses
   - Deploy through MDM

2. **Enterprise Developer Program**
   - In-house distribution
   - Custom B2B apps
   - Volume Purchase Program

### Government Deployment

#### Security Requirements
- **FISMA compliance**: Federal security standards
- **CJIS compliance**: Criminal justice information
- **FedRAMP authorization**: Cloud security
- **STIG compliance**: Security technical guides

#### Deployment Process
1. **Security assessment**: Third-party evaluation
2. **Authority to Operate (ATO)**: Government approval
3. **Specialized app stores**: Government-specific distribution
4. **On-premise deployment**: Air-gapped environments

## 🔒 Security Configuration

### Code Signing

#### Android
```bash
# Generate keystore
keytool -genkey -v -keystore inframonitor.keystore -alias inframonitor -keyalg RSA -keysize 2048 -validity 10000

# Configure in eas.json
{
  "build": {
    "production": {
      "android": {
        "buildType": "aab",
        "gradleCommand": ":app:bundleRelease"
      }
    }
  }
}
```

#### iOS
- Use Xcode automatic signing
- Or configure manual provisioning profiles
- Ensure certificates are valid

### App Transport Security (iOS)
```xml
<!-- Info.plist -->
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsArbitraryLoads</key>
    <false/>
    <key>NSExceptionDomains</key>
    <dict>
        <key>api.inframonitor.com</key>
        <dict>
            <key>NSExceptionRequiresForwardSecrecy</key>
            <false/>
            <key>NSExceptionMinimumTLSVersion</key>
            <string>TLSv1.2</string>
        </dict>
    </dict>
</dict>
```

### Network Security Config (Android)
```xml
<!-- network_security_config.xml -->
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config cleartextTrafficPermitted="false">
        <domain includeSubdomains="true">api.inframonitor.com</domain>
    </domain-config>
</network-security-config>
```

## 📊 Monitoring and Analytics

### Crash Reporting
```bash
# Install Sentry
npm install @sentry/react-native

# Configure in App.js
import * as Sentry from '@sentry/react-native';

Sentry.init({
  dsn: 'YOUR_SENTRY_DSN',
});
```

### Performance Monitoring
```javascript
// Performance tracking
import { Performance } from '@react-native-firebase/perf';

const trace = Performance().newTrace('app_startup');
trace.start();
// ... app initialization
trace.stop();
```

### Usage Analytics
```javascript
// Analytics tracking
import analytics from '@react-native-firebase/analytics';

analytics().logEvent('screen_view', {
  screen_name: 'Dashboard',
  screen_class: 'DashboardScreen',
});
```

## 🚀 Continuous Integration/Deployment

### GitHub Actions

Create `.github/workflows/build.yml`:

```yaml
name: Build and Deploy

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Setup Node.js
      uses: actions/setup-node@v3
      with:
        node-version: '18'
        cache: 'npm'
    
    - name: Install dependencies
      run: npm ci
    
    - name: Run tests
      run: npm test
    
    - name: Setup Expo
      uses: expo/expo-github-action@v8
      with:
        expo-version: latest
        token: ${{ secrets.EXPO_TOKEN }}
    
    - name: Build Android
      run: eas build --platform android --non-interactive
      if: github.ref == 'refs/heads/main'
    
    - name: Build iOS
      run: eas build --platform ios --non-interactive
      if: github.ref == 'refs/heads/main'
```

### Automated Testing
```yaml
- name: Run E2E tests
  run: |
    npm run test:e2e:android
    npm run test:e2e:ios
```

## 📋 Release Checklist

### Pre-Release
- [ ] Update version numbers in `app.json` and `package.json`
- [ ] Update build numbers for iOS and Android
- [ ] Test on physical devices
- [ ] Verify all features work offline
- [ ] Check app permissions
- [ ] Validate API integrations
- [ ] Review security configurations
- [ ] Update documentation

### Build Process
- [ ] Clean build environment
- [ ] Run automated tests
- [ ] Build release versions
- [ ] Test release builds
- [ ] Verify app signing
- [ ] Check bundle sizes

### Store Submission
- [ ] Prepare store assets (screenshots, descriptions)
- [ ] Submit to app stores
- [ ] Monitor review process
- [ ] Respond to reviewer feedback
- [ ] Plan release communications

### Post-Release
- [ ] Monitor crash reports
- [ ] Track user feedback
- [ ] Monitor performance metrics
- [ ] Plan next release cycle

## 🆘 Troubleshooting

### Common Build Issues

#### Android
```bash
# Clear cache
npx expo start --clear

# Reset Metro bundler
npx react-native start --reset-cache

# Clean Android build
cd android && ./gradlew clean
```

#### iOS
```bash
# Clear derived data
rm -rf ~/Library/Developer/Xcode/DerivedData

# Reset iOS simulator
xcrun simctl erase all
```

### Performance Issues
- Optimize bundle size with tree shaking
- Use lazy loading for screens
- Optimize images and assets
- Profile with React DevTools

### Deployment Issues
- Verify certificates and provisioning profiles
- Check app store guidelines compliance
- Validate metadata and assets
- Test on multiple device types

## 📞 Support

### Technical Support
- **Documentation**: https://docs.inframonitor.com
- **API Reference**: https://api.inframonitor.com/docs
- **Developer Support**: dev-support@inframonitor.com

### Emergency Contacts
- **Critical Issues**: emergency@inframonitor.com
- **Security Issues**: security@inframonitor.com
- **On-call Support**: +1-800-INFRA-MON

---

This deployment guide ensures successful deployment of the Infrastructure Monitoring mobile application across all target platforms and distribution channels.


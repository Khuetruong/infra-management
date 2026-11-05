# Infrastructure Monitoring Mobile App

A professional React Native mobile application for infrastructure monitoring and management, built with Expo and featuring comprehensive device management, network scanning, and AI-powered analytics.

## 📱 App Overview

The Infrastructure Monitoring App provides a complete mobile solution for monitoring and managing IT infrastructure across different subscription tiers. Built with React Native and Expo, it offers native performance on both Android and iOS platforms.

### Key Features

- **Multi-tier Subscription System**: Basic, Professional, Enterprise, and Government plans
- **Device Management**: Monitor and control network devices remotely
- **Network Discovery**: Scan and discover devices on local networks
- **Real-time Alerts**: Instant notifications for system issues
- **AI Analytics**: Intelligent insights and predictive monitoring
- **Professional Dashboard**: Comprehensive overview of system health
- **Cross-platform**: Native Android and iOS applications

## 🏗️ Architecture

### Technology Stack

- **Framework**: React Native with Expo SDK 53
- **Navigation**: React Navigation 6
- **UI Components**: Custom components with Expo Vector Icons
- **State Management**: React Hooks and Context
- **Styling**: StyleSheet with responsive design
- **Build System**: Expo CLI and EAS Build

### Project Structure

```
InfrastructureMonitoringApp/
├── App.js                 # Main app component with navigation
├── src/
│   ├── screens/          # Screen components
│   │   ├── LoginScreen.js
│   │   ├── DashboardScreen.js
│   │   ├── DevicesScreen.js
│   │   ├── NetworkScreen.js
│   │   ├── AlertsScreen.js
│   │   ├── SettingsScreen.js
│   │   └── SubscriptionScreen.js
│   ├── components/       # Reusable components
│   ├── services/         # API and business logic
│   ├── utils/           # Utility functions
│   └── constants/       # App constants
├── assets/              # Images, icons, fonts
├── build/               # Build outputs
│   ├── android/         # Android APK
│   └── ios/            # iOS IPA
├── app.json            # Expo configuration
├── eas.json            # EAS Build configuration
└── package.json        # Dependencies and scripts
```

## 🚀 Getting Started

### Prerequisites

- Node.js 18+ and npm
- Expo CLI (`npm install -g @expo/cli`)
- For Android: Android Studio and Android SDK
- For iOS: Xcode (macOS only) and iOS SDK

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd InfrastructureMonitoringApp
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start development server**
   ```bash
   npm start
   ```

4. **Run on device/simulator**
   ```bash
   # Android
   npm run android
   
   # iOS
   npm run ios
   
   # Web (for testing)
   npm run web
   ```

### Demo Accounts

The app includes demo accounts for testing different subscription tiers:

- **Basic Plan**: `basic@demo.com` (password: any)
- **Professional Plan**: `pro@demo.com` (password: any)
- **Enterprise Plan**: `enterprise@demo.com` (password: any)
- **Government Plan**: `gov@demo.com` (password: any)

## 📱 App Features

### Authentication & Onboarding

- **Secure Login**: Email/password authentication with demo accounts
- **Subscription Selection**: Choose from 4 subscription tiers
- **Biometric Support**: Fingerprint and Face ID login (configurable)
- **Password Recovery**: Forgot password functionality

### Dashboard

- **System Overview**: Real-time statistics and health metrics
- **Performance Metrics**: CPU, memory, disk, and network usage
- **Quick Actions**: Direct access to key features
- **Subscription Status**: Current plan and upgrade options

### Device Management

- **Device Discovery**: Automatic detection of network devices
- **Device Control**: Start, stop, restart, and configure devices
- **Real-time Monitoring**: Live status updates and metrics
- **Device Details**: Comprehensive information and settings
- **Search & Filter**: Find devices quickly

### Network Scanning

- **Network Discovery**: Scan IP ranges for active devices
- **Port Scanning**: Identify open ports and services
- **Network Topology**: Visual representation of network structure
- **Custom Ranges**: Scan specific IP ranges
- **Saved Networks**: Store frequently scanned networks

### Alert Management

- **Real-time Alerts**: Instant notifications for issues
- **Alert Categories**: Critical, warning, and informational alerts
- **Alert Actions**: Acknowledge, resolve, and dismiss alerts
- **Alert History**: Complete audit trail of all alerts
- **Custom Filters**: Filter alerts by type and severity

### Settings & Configuration

- **Profile Management**: User account and preferences
- **Notification Settings**: Configure alert preferences
- **Security Settings**: Password, 2FA, and biometric options
- **Server Configuration**: API endpoints and authentication
- **Data Export**: Export monitoring data

## 🔧 Building for Production

### Android APK

1. **Configure app.json**
   ```json
   {
     "expo": {
       "android": {
         "package": "com.inframonitor.app",
         "versionCode": 1
       }
     }
   }
   ```

2. **Build APK**
   ```bash
   # Using build script
   ./build-apk.sh
   
   # Or manually
   npx expo export --platform android
   ```

3. **Output**: `build/android/Infrastructure-Monitor-v1.0.0-demo.apk`

### iOS IPA

1. **Configure app.json**
   ```json
   {
     "expo": {
       "ios": {
         "bundleIdentifier": "com.inframonitor.app",
         "buildNumber": "1"
       }
     }
   }
   ```

2. **Build IPA**
   ```bash
   # Using build script
   ./build-ios.sh
   
   # Or manually
   npx expo export --platform ios
   ```

3. **Output**: `build/ios/Infrastructure-Monitor-v1.0.0-demo.ipa`

### Production Builds with EAS

For production-ready builds with code signing:

```bash
# Install EAS CLI
npm install -g eas-cli

# Configure EAS
eas build:configure

# Build for Android
eas build --platform android

# Build for iOS
eas build --platform ios
```

## 📊 Subscription Plans

### Basic Plan ($29/month)
- Up to 10 devices
- 1 monitoring site
- Basic alerts and reporting
- Email support
- Mobile app access

### Professional Plan ($99/month)
- Up to 100 devices
- 5 monitoring sites
- Advanced alerts and AI insights
- Priority support
- Full platform access

### Enterprise Plan ($299/month)
- Unlimited devices and sites
- Advanced AI analytics
- 24/7 phone support
- API access and custom integrations
- Dedicated account manager

### Government Plan ($999/month)
- All Enterprise features
- Government-grade security
- AI behavior analysis and threat detection
- Emergency response integration
- Compliance reporting and audit trails

## 🔒 Security Features

### Authentication
- Secure email/password login
- Biometric authentication (fingerprint, Face ID)
- Session management and auto-logout
- Password strength requirements

### Data Protection
- HTTPS/TLS encryption for all communications
- Local data encryption on device
- Secure token storage
- Privacy-compliant data handling

### Government Security (Government Plan)
- Military-grade encryption
- Multi-level access control
- Audit trails and compliance reporting
- Classified data handling capabilities

## 🌐 API Integration

The app integrates with the Infrastructure Monitoring backend API:

### Base Configuration
```javascript
const API_BASE_URL = 'https://api.inframonitor.com';
const API_ENDPOINTS = {
  auth: '/api/auth',
  devices: '/api/devices',
  network: '/api/network',
  alerts: '/api/alerts',
  analytics: '/api/analytics'
};
```

### Authentication
```javascript
// Login
POST /api/auth/login
{
  "email": "user@example.com",
  "password": "password"
}

// Response
{
  "token": "jwt_token",
  "user": { ... },
  "subscription": "professional"
}
```

### Device Management
```javascript
// Get devices
GET /api/devices

// Control device
POST /api/devices/{id}/action
{
  "action": "restart"
}
```

## 🧪 Testing

### Manual Testing
1. Install the app on a test device
2. Test login with demo accounts
3. Verify all screens and navigation
4. Test device management features
5. Verify alert notifications
6. Test subscription plan differences

### Automated Testing
```bash
# Run tests (when implemented)
npm test

# Run E2E tests
npm run test:e2e
```

## 📱 Device Compatibility

### Android
- **Minimum Version**: Android 7.0 (API level 24)
- **Target Version**: Android 14 (API level 34)
- **Architecture**: ARM64, ARMv7
- **Permissions**: Internet, Network State, WiFi State, Camera, Vibrate

### iOS
- **Minimum Version**: iOS 13.0
- **Target Version**: iOS 17.0
- **Architecture**: ARM64
- **Capabilities**: Network access, Camera, Location (when in use)

## 🚀 Deployment

### Development
- Use Expo Go app for quick testing
- Hot reload for rapid development
- Web version for cross-platform testing

### Staging
- Build preview APK/IPA for internal testing
- TestFlight for iOS beta testing
- Internal distribution for Android

### Production
- App Store (iOS) and Google Play Store (Android)
- Enterprise distribution for corporate clients
- Government app stores for government clients

## 📞 Support

### Technical Support
- **Email**: support@inframonitor.com
- **Documentation**: https://docs.inframonitor.com
- **API Reference**: https://api.inframonitor.com/docs

### Business Inquiries
- **Sales**: sales@inframonitor.com
- **Partnerships**: partners@inframonitor.com
- **Government**: government@inframonitor.com

## 📄 License

Copyright © 2024 Infrastructure Monitor. All rights reserved.

This software is proprietary and confidential. Unauthorized copying, distribution, or use is strictly prohibited.

---

**Infrastructure Monitor** - Professional infrastructure monitoring for the modern enterprise.


---

## 🆕 Nền tảng quản lý hạ tầng (web + agent)

Xem **[PLATFORM.md](PLATFORM.md)**: control plane (`server/`), agent cài trên server (`agent/`) và giao diện web để kết nối và quản trị server thật (bảo mật, database, dịch vụ, cập nhật).

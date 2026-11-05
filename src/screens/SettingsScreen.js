import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  Alert,
  Modal,
  TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export default function SettingsScreen({ navigation, route, onLogout }) {
  const [notifications, setNotifications] = useState(true);
  const [darkMode, setDarkMode] = useState(false);
  const [autoSync, setAutoSync] = useState(true);
  const [biometric, setBiometric] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [modalType, setModalType] = useState('');
  const [serverUrl, setServerUrl] = useState('https://api.inframonitor.com');
  const [apiKey, setApiKey] = useState('');

  const userSubscription = route?.params?.userSubscription || 'basic';

  const handleLogout = () => {
    Alert.alert(
      'Logout',
      'Are you sure you want to logout?',
      [
        { text: 'Cancel', style: 'cancel' },
        { 
          text: 'Logout', 
          style: 'destructive',
          onPress: () => {
            if (onLogout) {
              onLogout();
            }
          }
        },
      ]
    );
  };

  const openModal = (type) => {
    setModalType(type);
    setModalVisible(true);
  };

  const closeModal = () => {
    setModalVisible(false);
    setModalType('');
  };

  const saveSettings = () => {
    Alert.alert('Success', 'Settings saved successfully');
    closeModal();
  };

  const exportData = () => {
    Alert.alert('Export Data', 'Data export will be available in your email within 24 hours');
  };

  const clearCache = () => {
    Alert.alert(
      'Clear Cache',
      'This will clear all cached data. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        { 
          text: 'Clear', 
          onPress: () => Alert.alert('Success', 'Cache cleared successfully')
        },
      ]
    );
  };

  const getSubscriptionColor = () => {
    const colors = {
      basic: '#4CAF50',
      professional: '#2196F3',
      enterprise: '#FF9800',
      government: '#9C27B0',
    };
    return colors[userSubscription] || '#4CAF50';
  };

  const SettingItem = ({ icon, title, subtitle, onPress, rightComponent, showArrow = true }) => (
    <TouchableOpacity style={styles.settingItem} onPress={onPress}>
      <View style={styles.settingIcon}>
        <Ionicons name={icon} size={24} color="#007AFF" />
      </View>
      <View style={styles.settingContent}>
        <Text style={styles.settingTitle}>{title}</Text>
        {subtitle && <Text style={styles.settingSubtitle}>{subtitle}</Text>}
      </View>
      {rightComponent || (showArrow && (
        <Ionicons name="chevron-forward" size={20} color="#ccc" />
      ))}
    </TouchableOpacity>
  );

  const SwitchItem = ({ icon, title, subtitle, value, onValueChange }) => (
    <SettingItem
      icon={icon}
      title={title}
      subtitle={subtitle}
      rightComponent={
        <Switch
          value={value}
          onValueChange={onValueChange}
          trackColor={{ false: '#767577', true: '#007AFF' }}
          thumbColor={value ? '#fff' : '#f4f3f4'}
        />
      }
      showArrow={false}
    />
  );

  const renderModal = () => {
    switch (modalType) {
      case 'server':
        return (
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Server Configuration</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="Server URL"
              value={serverUrl}
              onChangeText={setServerUrl}
            />
            <TextInput
              style={styles.modalInput}
              placeholder="API Key"
              value={apiKey}
              onChangeText={setApiKey}
              secureTextEntry
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalButton} onPress={closeModal}>
                <Text style={styles.modalButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.modalButton, styles.modalButtonPrimary]} 
                onPress={saveSettings}
              >
                <Text style={[styles.modalButtonText, styles.modalButtonTextPrimary]}>
                  Save
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        );
      
      case 'about':
        return (
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>About Infrastructure Monitor</Text>
            <View style={styles.aboutContent}>
              <Text style={styles.aboutText}>Version: 1.0.0</Text>
              <Text style={styles.aboutText}>Build: 2024.01.15</Text>
              <Text style={styles.aboutText}>
                Subscription: {userSubscription.charAt(0).toUpperCase() + userSubscription.slice(1)}
              </Text>
              <Text style={styles.aboutDescription}>
                Professional infrastructure monitoring solution for businesses and organizations.
              </Text>
            </View>
            <TouchableOpacity style={styles.modalButton} onPress={closeModal}>
              <Text style={styles.modalButtonText}>Close</Text>
            </TouchableOpacity>
          </View>
        );
      
      default:
        return null;
    }
  };

  return (
    <ScrollView style={styles.container}>
      {/* Profile Section */}
      <View style={styles.profileSection}>
        <View style={styles.profileIcon}>
          <Ionicons name="person" size={40} color="#fff" />
        </View>
        <View style={styles.profileInfo}>
          <Text style={styles.profileName}>Demo User</Text>
          <Text style={styles.profileEmail}>demo@inframonitor.com</Text>
          <View style={[styles.subscriptionBadge, { backgroundColor: getSubscriptionColor() }]}>
            <Text style={styles.subscriptionText}>
              {userSubscription.charAt(0).toUpperCase() + userSubscription.slice(1)} Plan
            </Text>
          </View>
        </View>
      </View>

      {/* Account Settings */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Account</Text>
        <SettingItem
          icon="person-circle"
          title="Profile"
          subtitle="Manage your profile information"
          onPress={() => Alert.alert('Profile', 'Profile management coming soon')}
        />
        <SettingItem
          icon="card"
          title="Subscription"
          subtitle={`Current plan: ${userSubscription}`}
          onPress={() => navigation.navigate('Subscription')}
        />
        <SettingItem
          icon="shield-checkmark"
          title="Security"
          subtitle="Password, 2FA, and security settings"
          onPress={() => Alert.alert('Security', 'Security settings coming soon')}
        />
      </View>

      {/* App Settings */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>App Settings</Text>
        <SwitchItem
          icon="notifications"
          title="Push Notifications"
          subtitle="Receive alerts and updates"
          value={notifications}
          onValueChange={setNotifications}
        />
        <SwitchItem
          icon="moon"
          title="Dark Mode"
          subtitle="Use dark theme"
          value={darkMode}
          onValueChange={setDarkMode}
        />
        <SwitchItem
          icon="sync"
          title="Auto Sync"
          subtitle="Automatically sync data"
          value={autoSync}
          onValueChange={setAutoSync}
        />
        <SwitchItem
          icon="finger-print"
          title="Biometric Login"
          subtitle="Use fingerprint or face ID"
          value={biometric}
          onValueChange={setBiometric}
        />
      </View>

      {/* System Settings */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>System</Text>
        <SettingItem
          icon="server"
          title="Server Configuration"
          subtitle="API endpoint and authentication"
          onPress={() => openModal('server')}
        />
        <SettingItem
          icon="download"
          title="Export Data"
          subtitle="Download your monitoring data"
          onPress={exportData}
        />
        <SettingItem
          icon="trash"
          title="Clear Cache"
          subtitle="Free up storage space"
          onPress={clearCache}
        />
      </View>

      {/* Support */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Support</Text>
        <SettingItem
          icon="help-circle"
          title="Help & FAQ"
          subtitle="Get help and find answers"
          onPress={() => Alert.alert('Help', 'Help documentation coming soon')}
        />
        <SettingItem
          icon="mail"
          title="Contact Support"
          subtitle="Get in touch with our team"
          onPress={() => Alert.alert('Contact', 'support@inframonitor.com')}
        />
        <SettingItem
          icon="information-circle"
          title="About"
          subtitle="App version and information"
          onPress={() => openModal('about')}
        />
      </View>

      {/* Logout */}
      <View style={styles.section}>
        <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
          <Ionicons name="log-out" size={24} color="#F44336" />
          <Text style={styles.logoutText}>Logout</Text>
        </TouchableOpacity>
      </View>

      {/* Modal */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={modalVisible}
        onRequestClose={closeModal}
      >
        <View style={styles.modalOverlay}>
          {renderModal()}
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  profileSection: {
    backgroundColor: '#007AFF',
    padding: 20,
    flexDirection: 'row',
    alignItems: 'center',
  },
  profileIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 15,
  },
  profileInfo: {
    flex: 1,
  },
  profileName: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
  },
  profileEmail: {
    fontSize: 16,
    color: 'rgba(255, 255, 255, 0.8)',
    marginTop: 4,
  },
  subscriptionBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 15,
    marginTop: 8,
  },
  subscriptionText: {
    fontSize: 12,
    color: '#fff',
    fontWeight: 'bold',
  },
  section: {
    backgroundColor: '#fff',
    marginTop: 20,
    paddingVertical: 10,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#333',
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: '#f8f9fa',
  },
  settingItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  settingIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#f0f8ff',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 15,
  },
  settingContent: {
    flex: 1,
  },
  settingTitle: {
    fontSize: 16,
    fontWeight: '500',
    color: '#333',
  },
  settingSubtitle: {
    fontSize: 14,
    color: '#666',
    marginTop: 2,
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    paddingVertical: 15,
    marginHorizontal: 20,
    marginVertical: 20,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#F44336',
  },
  logoutText: {
    fontSize: 16,
    fontWeight: '500',
    color: '#F44336',
    marginLeft: 10,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 20,
    width: '90%',
    maxHeight: '80%',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 20,
    textAlign: 'center',
  },
  modalInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginBottom: 15,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: 20,
  },
  modalButton: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#007AFF',
    minWidth: 100,
    alignItems: 'center',
  },
  modalButtonPrimary: {
    backgroundColor: '#007AFF',
  },
  modalButtonText: {
    fontSize: 16,
    color: '#007AFF',
    fontWeight: '500',
  },
  modalButtonTextPrimary: {
    color: '#fff',
  },
  aboutContent: {
    marginBottom: 20,
  },
  aboutText: {
    fontSize: 16,
    color: '#333',
    marginBottom: 8,
  },
  aboutDescription: {
    fontSize: 14,
    color: '#666',
    marginTop: 15,
    lineHeight: 20,
  },
});


import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  Alert,
  Modal,
  TextInput,
  Switch,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export default function DevicesScreen({ route }) {
  const [devices, setDevices] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  const userSubscription = route?.params?.userSubscription || 'basic';

  useEffect(() => {
    loadDevices();
  }, []);

  const loadDevices = async () => {
    try {
      // Simulate API call
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const mockDevices = generateMockDevices(userSubscription);
      setDevices(mockDevices);
    } catch (error) {
      console.error('Error loading devices:', error);
    }
  };

  const generateMockDevices = (subscription) => {
    const deviceTypes = [
      { type: 'Router', icon: 'wifi', brand: 'Cisco' },
      { type: 'Switch', icon: 'git-network', brand: 'Netgear' },
      { type: 'Server', icon: 'server', brand: 'Dell' },
      { type: 'Firewall', icon: 'shield', brand: 'SonicWall' },
      { type: 'Access Point', icon: 'radio', brand: 'Ubiquiti' },
      { type: 'Camera', icon: 'videocam', brand: 'Hikvision' },
      { type: 'Sensor', icon: 'thermometer', brand: 'Honeywell' },
    ];

    const maxDevices = {
      basic: 10,
      professional: 100,
      enterprise: 1000,
      government: 10000,
    }[subscription] || 10;

    const deviceCount = Math.min(Math.floor(Math.random() * 20) + 5, maxDevices);
    
    return Array.from({ length: deviceCount }, (_, index) => {
      const deviceType = deviceTypes[Math.floor(Math.random() * deviceTypes.length)];
      const isOnline = Math.random() > 0.2;
      
      return {
        id: `device_${index + 1}`,
        name: `${deviceType.brand} ${deviceType.type} ${index + 1}`,
        type: deviceType.type,
        icon: deviceType.icon,
        brand: deviceType.brand,
        ip: `192.168.1.${Math.floor(Math.random() * 254) + 1}`,
        mac: Array.from({ length: 6 }, () => 
          Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
        ).join(':'),
        status: isOnline ? 'online' : 'offline',
        lastSeen: isOnline ? 'Now' : `${Math.floor(Math.random() * 60) + 1}m ago`,
        uptime: isOnline ? `${Math.floor(Math.random() * 30) + 1}d ${Math.floor(Math.random() * 24)}h` : 'N/A',
        cpu: isOnline ? Math.floor(Math.random() * 80) + 10 : 0,
        memory: isOnline ? Math.floor(Math.random() * 70) + 20 : 0,
        temperature: isOnline ? Math.floor(Math.random() * 30) + 35 : 0,
        alerts: Math.floor(Math.random() * 3),
      };
    });
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await loadDevices();
    setRefreshing(false);
  };

  const handleDevicePress = (device) => {
    setSelectedDevice(device);
    setModalVisible(true);
  };

  const handleDeviceAction = (action, device) => {
    switch (action) {
      case 'restart':
        Alert.alert(
          'Restart Device',
          `Are you sure you want to restart ${device.name}?`,
          [
            { text: 'Cancel', style: 'cancel' },
            { 
              text: 'Restart', 
              style: 'destructive',
              onPress: () => {
                Alert.alert('Success', 'Device restart command sent');
                setModalVisible(false);
              }
            },
          ]
        );
        break;
      case 'configure':
        Alert.alert('Configure', `Opening configuration for ${device.name}`);
        break;
      case 'remove':
        Alert.alert(
          'Remove Device',
          `Are you sure you want to remove ${device.name}?`,
          [
            { text: 'Cancel', style: 'cancel' },
            { 
              text: 'Remove', 
              style: 'destructive',
              onPress: () => {
                setDevices(devices.filter(d => d.id !== device.id));
                setModalVisible(false);
                Alert.alert('Success', 'Device removed');
              }
            },
          ]
        );
        break;
    }
  };

  const getStatusColor = (status) => {
    return status === 'online' ? '#4CAF50' : '#F44336';
  };

  const getHealthColor = (value) => {
    if (value >= 80) return '#F44336';
    if (value >= 60) return '#FF9800';
    return '#4CAF50';
  };

  const filteredDevices = devices.filter(device =>
    device.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    device.type.toLowerCase().includes(searchQuery.toLowerCase()) ||
    device.ip.includes(searchQuery)
  );

  const DeviceCard = ({ device }) => (
    <TouchableOpacity 
      style={styles.deviceCard}
      onPress={() => handleDevicePress(device)}
    >
      <View style={styles.deviceHeader}>
        <View style={styles.deviceIcon}>
          <Ionicons name={device.icon} size={24} color="#007AFF" />
        </View>
        <View style={styles.deviceInfo}>
          <Text style={styles.deviceName}>{device.name}</Text>
          <Text style={styles.deviceType}>{device.type} • {device.ip}</Text>
        </View>
        <View style={[styles.statusIndicator, { backgroundColor: getStatusColor(device.status) }]} />
      </View>
      
      <View style={styles.deviceMetrics}>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>CPU</Text>
          <Text style={[styles.metricValue, { color: getHealthColor(device.cpu) }]}>
            {device.cpu}%
          </Text>
        </View>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>Memory</Text>
          <Text style={[styles.metricValue, { color: getHealthColor(device.memory) }]}>
            {device.memory}%
          </Text>
        </View>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>Temp</Text>
          <Text style={styles.metricValue}>{device.temperature}°C</Text>
        </View>
        {device.alerts > 0 && (
          <View style={styles.alertBadge}>
            <Ionicons name="warning" size={12} color="#fff" />
            <Text style={styles.alertText}>{device.alerts}</Text>
          </View>
        )}
      </View>
      
      <View style={styles.deviceFooter}>
        <Text style={styles.lastSeen}>Last seen: {device.lastSeen}</Text>
        <Text style={styles.uptime}>Uptime: {device.uptime}</Text>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {/* Search Bar */}
      <View style={styles.searchContainer}>
        <Ionicons name="search" size={20} color="#666" style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search devices..."
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
        <TouchableOpacity style={styles.addButton}>
          <Ionicons name="add" size={24} color="#007AFF" />
        </TouchableOpacity>
      </View>

      {/* Device Stats */}
      <View style={styles.statsContainer}>
        <View style={styles.statItem}>
          <Text style={styles.statValue}>{devices.length}</Text>
          <Text style={styles.statLabel}>Total</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={[styles.statValue, { color: '#4CAF50' }]}>
            {devices.filter(d => d.status === 'online').length}
          </Text>
          <Text style={styles.statLabel}>Online</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={[styles.statValue, { color: '#F44336' }]}>
            {devices.filter(d => d.status === 'offline').length}
          </Text>
          <Text style={styles.statLabel}>Offline</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={[styles.statValue, { color: '#FF9800' }]}>
            {devices.reduce((sum, d) => sum + d.alerts, 0)}
          </Text>
          <Text style={styles.statLabel}>Alerts</Text>
        </View>
      </View>

      {/* Device List */}
      <FlatList
        data={filteredDevices}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <DeviceCard device={item} />}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        contentContainerStyle={styles.listContainer}
        showsVerticalScrollIndicator={false}
      />

      {/* Device Detail Modal */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={modalVisible}
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            {selectedDevice && (
              <>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>{selectedDevice.name}</Text>
                  <TouchableOpacity onPress={() => setModalVisible(false)}>
                    <Ionicons name="close" size={24} color="#666" />
                  </TouchableOpacity>
                </View>

                <View style={styles.modalBody}>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Type:</Text>
                    <Text style={styles.detailValue}>{selectedDevice.type}</Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>IP Address:</Text>
                    <Text style={styles.detailValue}>{selectedDevice.ip}</Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>MAC Address:</Text>
                    <Text style={styles.detailValue}>{selectedDevice.mac}</Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Status:</Text>
                    <Text style={[styles.detailValue, { color: getStatusColor(selectedDevice.status) }]}>
                      {selectedDevice.status.toUpperCase()}
                    </Text>
                  </View>
                </View>

                <View style={styles.modalActions}>
                  <TouchableOpacity 
                    style={[styles.actionButton, styles.restartButton]}
                    onPress={() => handleDeviceAction('restart', selectedDevice)}
                  >
                    <Ionicons name="refresh" size={20} color="#fff" />
                    <Text style={styles.actionButtonText}>Restart</Text>
                  </TouchableOpacity>
                  
                  <TouchableOpacity 
                    style={[styles.actionButton, styles.configButton]}
                    onPress={() => handleDeviceAction('configure', selectedDevice)}
                  >
                    <Ionicons name="settings" size={20} color="#fff" />
                    <Text style={styles.actionButtonText}>Configure</Text>
                  </TouchableOpacity>
                  
                  <TouchableOpacity 
                    style={[styles.actionButton, styles.removeButton]}
                    onPress={() => handleDeviceAction('remove', selectedDevice)}
                  >
                    <Ionicons name="trash" size={20} color="#fff" />
                    <Text style={styles.actionButtonText}>Remove</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    margin: 15,
    borderRadius: 12,
    paddingHorizontal: 15,
    height: 50,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  searchIcon: {
    marginRight: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    color: '#333',
  },
  addButton: {
    padding: 5,
  },
  statsContainer: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    marginHorizontal: 15,
    marginBottom: 15,
    borderRadius: 12,
    padding: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#333',
  },
  statLabel: {
    fontSize: 12,
    color: '#666',
    marginTop: 4,
  },
  listContainer: {
    paddingHorizontal: 15,
    paddingBottom: 20,
  },
  deviceCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 15,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  deviceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  deviceIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#f0f8ff',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  deviceInfo: {
    flex: 1,
  },
  deviceName: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#333',
  },
  deviceType: {
    fontSize: 14,
    color: '#666',
    marginTop: 2,
  },
  statusIndicator: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  deviceMetrics: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  metric: {
    marginRight: 20,
  },
  metricLabel: {
    fontSize: 12,
    color: '#666',
  },
  metricValue: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#333',
  },
  alertBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FF9800',
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginLeft: 'auto',
  },
  alertText: {
    fontSize: 12,
    color: '#fff',
    marginLeft: 2,
  },
  deviceFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  lastSeen: {
    fontSize: 12,
    color: '#666',
  },
  uptime: {
    fontSize: 12,
    color: '#666',
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
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#333',
  },
  modalBody: {
    marginBottom: 20,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  detailLabel: {
    fontSize: 16,
    color: '#666',
  },
  detailValue: {
    fontSize: 16,
    fontWeight: '500',
    color: '#333',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 15,
    paddingVertical: 10,
    borderRadius: 8,
    minWidth: 80,
  },
  restartButton: {
    backgroundColor: '#2196F3',
  },
  configButton: {
    backgroundColor: '#4CAF50',
  },
  removeButton: {
    backgroundColor: '#F44336',
  },
  actionButtonText: {
    color: '#fff',
    marginLeft: 5,
    fontSize: 14,
    fontWeight: '500',
  },
});


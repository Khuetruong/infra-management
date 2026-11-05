import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Alert,
  ActivityIndicator,
  TextInput,
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

export default function NetworkScreen({ route }) {
  const [scanning, setScanning] = useState(false);
  const [networks, setNetworks] = useState([]);
  const [scanProgress, setScanProgress] = useState(0);
  const [selectedNetwork, setSelectedNetwork] = useState(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [customRange, setCustomRange] = useState('192.168.1.0/24');

  const userSubscription = route?.params?.userSubscription || 'basic';

  useEffect(() => {
    // Load saved networks on component mount
    loadSavedNetworks();
  }, []);

  const loadSavedNetworks = () => {
    // Simulate loading saved networks
    const mockNetworks = [
      {
        id: '1',
        name: 'Home Network',
        range: '192.168.1.0/24',
        gateway: '192.168.1.1',
        devices: 12,
        lastScan: '2 hours ago',
        status: 'active',
      },
      {
        id: '2',
        name: 'Guest Network',
        range: '192.168.2.0/24',
        gateway: '192.168.2.1',
        devices: 3,
        lastScan: '1 day ago',
        status: 'inactive',
      },
    ];
    setNetworks(mockNetworks);
  };

  const startNetworkScan = async (range = customRange) => {
    if (scanning) return;

    setScanning(true);
    setScanProgress(0);

    try {
      // Simulate network scanning with progress
      for (let i = 0; i <= 100; i += 10) {
        await new Promise(resolve => setTimeout(resolve, 200));
        setScanProgress(i);
      }

      // Generate mock scan results
      const scanResults = generateScanResults(range);
      
      // Update or add network
      const existingIndex = networks.findIndex(n => n.range === range);
      if (existingIndex >= 0) {
        const updatedNetworks = [...networks];
        updatedNetworks[existingIndex] = {
          ...updatedNetworks[existingIndex],
          devices: scanResults.devices.length,
          lastScan: 'Just now',
          status: 'active',
        };
        setNetworks(updatedNetworks);
      } else {
        const newNetwork = {
          id: Date.now().toString(),
          name: `Network ${networks.length + 1}`,
          range,
          gateway: range.split('/')[0].replace(/\d+$/, '1'),
          devices: scanResults.devices.length,
          lastScan: 'Just now',
          status: 'active',
        };
        setNetworks([...networks, newNetwork]);
      }

      Alert.alert(
        'Scan Complete',
        `Found ${scanResults.devices.length} devices on network ${range}`,
        [
          { text: 'OK' },
          { 
            text: 'View Details', 
            onPress: () => {
              setSelectedNetwork({ ...scanResults, range });
              setModalVisible(true);
            }
          }
        ]
      );
    } catch (error) {
      Alert.alert('Error', 'Network scan failed. Please try again.');
    } finally {
      setScanning(false);
      setScanProgress(0);
    }
  };

  const generateScanResults = (range) => {
    const baseIP = range.split('/')[0].split('.').slice(0, 3).join('.');
    const deviceCount = Math.floor(Math.random() * 20) + 5;
    
    const deviceTypes = [
      { type: 'Router', icon: 'wifi', manufacturer: 'Cisco' },
      { type: 'Computer', icon: 'desktop', manufacturer: 'Dell' },
      { type: 'Phone', icon: 'phone-portrait', manufacturer: 'Apple' },
      { type: 'Tablet', icon: 'tablet-portrait', manufacturer: 'Samsung' },
      { type: 'Smart TV', icon: 'tv', manufacturer: 'LG' },
      { type: 'Printer', icon: 'print', manufacturer: 'HP' },
      { type: 'Camera', icon: 'videocam', manufacturer: 'Hikvision' },
      { type: 'Smart Speaker', icon: 'volume-high', manufacturer: 'Amazon' },
    ];

    const devices = Array.from({ length: deviceCount }, (_, index) => {
      const deviceType = deviceTypes[Math.floor(Math.random() * deviceTypes.length)];
      const ip = `${baseIP}.${Math.floor(Math.random() * 254) + 1}`;
      
      return {
        id: `device_${index}`,
        ip,
        hostname: `${deviceType.type.toLowerCase()}-${index + 1}`,
        type: deviceType.type,
        icon: deviceType.icon,
        manufacturer: deviceType.manufacturer,
        mac: Array.from({ length: 6 }, () => 
          Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
        ).join(':'),
        ports: generateOpenPorts(),
        responseTime: Math.floor(Math.random() * 50) + 1,
        status: Math.random() > 0.1 ? 'online' : 'offline',
      };
    });

    return { devices };
  };

  const generateOpenPorts = () => {
    const commonPorts = [22, 23, 53, 80, 443, 993, 995, 3389, 5900, 8080];
    const portCount = Math.floor(Math.random() * 5) + 1;
    return commonPorts.slice(0, portCount);
  };

  const handleNetworkPress = (network) => {
    Alert.alert(
      network.name,
      `Range: ${network.range}\nDevices: ${network.devices}\nLast scan: ${network.lastScan}`,
      [
        { text: 'Cancel' },
        { text: 'Scan Again', onPress: () => startNetworkScan(network.range) },
        { 
          text: 'View Details', 
          onPress: () => {
            const mockResults = generateScanResults(network.range);
            setSelectedNetwork({ ...mockResults, range: network.range, name: network.name });
            setModalVisible(true);
          }
        }
      ]
    );
  };

  const NetworkCard = ({ network }) => (
    <TouchableOpacity 
      style={styles.networkCard}
      onPress={() => handleNetworkPress(network)}
    >
      <View style={styles.networkHeader}>
        <View style={styles.networkIcon}>
          <Ionicons name="wifi" size={24} color="#007AFF" />
        </View>
        <View style={styles.networkInfo}>
          <Text style={styles.networkName}>{network.name}</Text>
          <Text style={styles.networkRange}>{network.range}</Text>
        </View>
        <View style={[
          styles.statusIndicator, 
          { backgroundColor: network.status === 'active' ? '#4CAF50' : '#F44336' }
        ]} />
      </View>
      
      <View style={styles.networkStats}>
        <View style={styles.stat}>
          <Text style={styles.statValue}>{network.devices}</Text>
          <Text style={styles.statLabel}>Devices</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statValue}>{network.gateway}</Text>
          <Text style={styles.statLabel}>Gateway</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statValue}>{network.lastScan}</Text>
          <Text style={styles.statLabel}>Last Scan</Text>
        </View>
      </View>
    </TouchableOpacity>
  );

  const DeviceItem = ({ device }) => (
    <View style={styles.deviceItem}>
      <View style={styles.deviceIcon}>
        <Ionicons name={device.icon} size={20} color="#007AFF" />
      </View>
      <View style={styles.deviceDetails}>
        <Text style={styles.deviceIP}>{device.ip}</Text>
        <Text style={styles.deviceHostname}>{device.hostname}</Text>
        <Text style={styles.deviceType}>{device.type} • {device.manufacturer}</Text>
        <Text style={styles.deviceMac}>MAC: {device.mac}</Text>
        {device.ports.length > 0 && (
          <Text style={styles.devicePorts}>
            Ports: {device.ports.join(', ')}
          </Text>
        )}
      </View>
      <View style={styles.deviceStatus}>
        <Text style={[
          styles.statusText,
          { color: device.status === 'online' ? '#4CAF50' : '#F44336' }
        ]}>
          {device.status}
        </Text>
        <Text style={styles.responseTime}>{device.responseTime}ms</Text>
      </View>
    </View>
  );

  return (
    <View style={styles.container}>
      {/* Scan Controls */}
      <View style={styles.scanContainer}>
        <View style={styles.inputContainer}>
          <Text style={styles.inputLabel}>Network Range:</Text>
          <TextInput
            style={styles.rangeInput}
            value={customRange}
            onChangeText={setCustomRange}
            placeholder="192.168.1.0/24"
            editable={!scanning}
          />
        </View>
        
        <TouchableOpacity
          style={[styles.scanButton, scanning && styles.scanButtonDisabled]}
          onPress={() => startNetworkScan()}
          disabled={scanning}
        >
          <LinearGradient
            colors={scanning ? ['#ccc', '#999'] : ['#007AFF', '#0051D5']}
            style={styles.scanButtonGradient}
          >
            {scanning ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Ionicons name="scan" size={24} color="#fff" />
            )}
            <Text style={styles.scanButtonText}>
              {scanning ? 'Scanning...' : 'Start Scan'}
            </Text>
          </LinearGradient>
        </TouchableOpacity>
      </View>

      {/* Scan Progress */}
      {scanning && (
        <View style={styles.progressContainer}>
          <Text style={styles.progressText}>Scanning network... {scanProgress}%</Text>
          <View style={styles.progressBar}>
            <View style={[styles.progressFill, { width: `${scanProgress}%` }]} />
          </View>
        </View>
      )}

      {/* Quick Scan Options */}
      <View style={styles.quickScanContainer}>
        <Text style={styles.sectionTitle}>Quick Scan</Text>
        <View style={styles.quickScanButtons}>
          <TouchableOpacity
            style={styles.quickScanButton}
            onPress={() => startNetworkScan('192.168.1.0/24')}
            disabled={scanning}
          >
            <Text style={styles.quickScanText}>Home Network</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.quickScanButton}
            onPress={() => startNetworkScan('10.0.0.0/24')}
            disabled={scanning}
          >
            <Text style={styles.quickScanText}>Office Network</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.quickScanButton}
            onPress={() => startNetworkScan('172.16.0.0/24')}
            disabled={scanning}
          >
            <Text style={styles.quickScanText}>VPN Network</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Saved Networks */}
      <View style={styles.networksContainer}>
        <Text style={styles.sectionTitle}>Saved Networks</Text>
        <FlatList
          data={networks}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <NetworkCard network={item} />}
          showsVerticalScrollIndicator={false}
        />
      </View>

      {/* Network Details Modal */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={modalVisible}
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {selectedNetwork?.name || 'Network Details'}
              </Text>
              <TouchableOpacity onPress={() => setModalVisible(false)}>
                <Ionicons name="close" size={24} color="#666" />
              </TouchableOpacity>
            </View>

            {selectedNetwork && (
              <FlatList
                data={selectedNetwork.devices}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => <DeviceItem device={item} />}
                style={styles.devicesList}
                showsVerticalScrollIndicator={false}
              />
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
  scanContainer: {
    backgroundColor: '#fff',
    margin: 15,
    borderRadius: 12,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  inputContainer: {
    marginBottom: 15,
  },
  inputLabel: {
    fontSize: 16,
    fontWeight: '500',
    color: '#333',
    marginBottom: 8,
  },
  rangeInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    backgroundColor: '#f8f9fa',
  },
  scanButton: {
    borderRadius: 12,
    overflow: 'hidden',
  },
  scanButtonDisabled: {
    opacity: 0.6,
  },
  scanButtonGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 15,
  },
  scanButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
    marginLeft: 10,
  },
  progressContainer: {
    backgroundColor: '#fff',
    marginHorizontal: 15,
    marginBottom: 15,
    borderRadius: 12,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  progressText: {
    fontSize: 16,
    color: '#333',
    marginBottom: 10,
    textAlign: 'center',
  },
  progressBar: {
    height: 8,
    backgroundColor: '#e0e0e0',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#007AFF',
    borderRadius: 4,
  },
  quickScanContainer: {
    backgroundColor: '#fff',
    marginHorizontal: 15,
    marginBottom: 15,
    borderRadius: 12,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 15,
  },
  quickScanButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  quickScanButton: {
    flex: 1,
    backgroundColor: '#f0f8ff',
    borderRadius: 8,
    padding: 12,
    marginHorizontal: 4,
    alignItems: 'center',
  },
  quickScanText: {
    fontSize: 14,
    color: '#007AFF',
    fontWeight: '500',
  },
  networksContainer: {
    flex: 1,
    backgroundColor: '#fff',
    marginHorizontal: 15,
    marginBottom: 15,
    borderRadius: 12,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  networkCard: {
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 8,
    padding: 15,
    marginBottom: 10,
  },
  networkHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  networkIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#f0f8ff',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  networkInfo: {
    flex: 1,
  },
  networkName: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#333',
  },
  networkRange: {
    fontSize: 14,
    color: '#666',
    marginTop: 2,
  },
  statusIndicator: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  networkStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  stat: {
    alignItems: 'center',
  },
  statValue: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#333',
  },
  statLabel: {
    fontSize: 12,
    color: '#666',
    marginTop: 2,
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
    width: '95%',
    height: '80%',
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
  devicesList: {
    flex: 1,
  },
  deviceItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
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
  deviceDetails: {
    flex: 1,
  },
  deviceIP: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#333',
  },
  deviceHostname: {
    fontSize: 14,
    color: '#007AFF',
    marginTop: 2,
  },
  deviceType: {
    fontSize: 12,
    color: '#666',
    marginTop: 2,
  },
  deviceMac: {
    fontSize: 12,
    color: '#666',
    marginTop: 2,
  },
  devicePorts: {
    fontSize: 12,
    color: '#4CAF50',
    marginTop: 2,
  },
  deviceStatus: {
    alignItems: 'flex-end',
  },
  statusText: {
    fontSize: 14,
    fontWeight: 'bold',
  },
  responseTime: {
    fontSize: 12,
    color: '#666',
    marginTop: 2,
  },
});


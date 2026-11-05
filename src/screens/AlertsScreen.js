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
  Switch,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export default function AlertsScreen({ route }) {
  const [alerts, setAlerts] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('all'); // all, critical, warning, info
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedAlert, setSelectedAlert] = useState(null);

  const userSubscription = route?.params?.userSubscription || 'basic';

  useEffect(() => {
    loadAlerts();
  }, []);

  const loadAlerts = async () => {
    try {
      // Simulate API call
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const mockAlerts = generateMockAlerts(userSubscription);
      setAlerts(mockAlerts);
    } catch (error) {
      console.error('Error loading alerts:', error);
    }
  };

  const generateMockAlerts = (subscription) => {
    const alertTypes = [
      {
        type: 'Device Offline',
        icon: 'warning',
        severity: 'critical',
        description: 'Device has gone offline',
      },
      {
        type: 'High CPU Usage',
        icon: 'speedometer',
        severity: 'warning',
        description: 'CPU usage above threshold',
      },
      {
        type: 'Memory Alert',
        icon: 'layers',
        severity: 'warning',
        description: 'Memory usage is high',
      },
      {
        type: 'Network Anomaly',
        icon: 'wifi',
        severity: 'info',
        description: 'Unusual network activity detected',
      },
      {
        type: 'Security Alert',
        icon: 'shield',
        severity: 'critical',
        description: 'Potential security threat detected',
      },
      {
        type: 'Backup Failed',
        icon: 'cloud-upload',
        severity: 'warning',
        description: 'Scheduled backup failed',
      },
      {
        type: 'Temperature Alert',
        icon: 'thermometer',
        severity: 'warning',
        description: 'Device temperature is high',
      },
      {
        type: 'Disk Space Low',
        icon: 'server',
        severity: 'warning',
        description: 'Disk space below threshold',
      },
    ];

    // Add government-specific alerts for government subscription
    if (subscription === 'government') {
      alertTypes.push(
        {
          type: 'Suspicious Activity',
          icon: 'eye',
          severity: 'critical',
          description: 'AI detected suspicious behavior',
        },
        {
          type: 'Unauthorized Access',
          icon: 'lock-open',
          severity: 'critical',
          description: 'Unauthorized access attempt detected',
        },
        {
          type: 'Threat Detection',
          icon: 'alert-circle',
          severity: 'critical',
          description: 'Potential threat identified',
        }
      );
    }

    const alertCount = Math.floor(Math.random() * 20) + 10;
    
    return Array.from({ length: alertCount }, (_, index) => {
      const alertType = alertTypes[Math.floor(Math.random() * alertTypes.length)];
      const timestamp = new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000);
      
      return {
        id: `alert_${index + 1}`,
        type: alertType.type,
        icon: alertType.icon,
        severity: alertType.severity,
        description: alertType.description,
        device: `Device-${Math.floor(Math.random() * 50) + 1}`,
        location: `Site-${Math.floor(Math.random() * 5) + 1}`,
        timestamp,
        acknowledged: Math.random() > 0.7,
        resolved: Math.random() > 0.8,
        details: generateAlertDetails(alertType),
      };
    }).sort((a, b) => b.timestamp - a.timestamp);
  };

  const generateAlertDetails = (alertType) => {
    const details = {
      'Device Offline': {
        lastSeen: '5 minutes ago',
        pingStatus: 'Failed',
        attempts: '3/3',
      },
      'High CPU Usage': {
        currentUsage: '89%',
        threshold: '80%',
        duration: '15 minutes',
      },
      'Memory Alert': {
        currentUsage: '92%',
        threshold: '85%',
        availableMemory: '1.2 GB',
      },
      'Security Alert': {
        threatLevel: 'High',
        sourceIP: '192.168.1.100',
        attackType: 'Brute Force',
      },
    };
    
    return details[alertType.type] || {};
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await loadAlerts();
    setRefreshing(false);
  };

  const handleAlertPress = (alert) => {
    setSelectedAlert(alert);
    setModalVisible(true);
  };

  const acknowledgeAlert = (alertId) => {
    setAlerts(alerts.map(alert => 
      alert.id === alertId 
        ? { ...alert, acknowledged: true }
        : alert
    ));
    Alert.alert('Success', 'Alert acknowledged');
  };

  const resolveAlert = (alertId) => {
    setAlerts(alerts.map(alert => 
      alert.id === alertId 
        ? { ...alert, resolved: true, acknowledged: true }
        : alert
    ));
    Alert.alert('Success', 'Alert resolved');
  };

  const deleteAlert = (alertId) => {
    Alert.alert(
      'Delete Alert',
      'Are you sure you want to delete this alert?',
      [
        { text: 'Cancel', style: 'cancel' },
        { 
          text: 'Delete', 
          style: 'destructive',
          onPress: () => {
            setAlerts(alerts.filter(alert => alert.id !== alertId));
            setModalVisible(false);
          }
        },
      ]
    );
  };

  const getSeverityColor = (severity) => {
    const colors = {
      critical: '#F44336',
      warning: '#FF9800',
      info: '#2196F3',
    };
    return colors[severity] || '#666';
  };

  const getSeverityIcon = (severity) => {
    const icons = {
      critical: 'alert-circle',
      warning: 'warning',
      info: 'information-circle',
    };
    return icons[severity] || 'information-circle';
  };

  const getTimeAgo = (timestamp) => {
    const now = new Date();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'Just now';
  };

  const filteredAlerts = alerts.filter(alert => {
    if (filter === 'all') return true;
    return alert.severity === filter;
  });

  const AlertCard = ({ alert }) => (
    <TouchableOpacity 
      style={[
        styles.alertCard,
        alert.resolved && styles.resolvedAlert,
        { borderLeftColor: getSeverityColor(alert.severity) }
      ]}
      onPress={() => handleAlertPress(alert)}
    >
      <View style={styles.alertHeader}>
        <View style={styles.alertIcon}>
          <Ionicons 
            name={alert.icon} 
            size={24} 
            color={getSeverityColor(alert.severity)} 
          />
        </View>
        <View style={styles.alertInfo}>
          <Text style={[styles.alertType, alert.resolved && styles.resolvedText]}>
            {alert.type}
          </Text>
          <Text style={[styles.alertDevice, alert.resolved && styles.resolvedText]}>
            {alert.device} • {alert.location}
          </Text>
        </View>
        <View style={styles.alertStatus}>
          <View style={[
            styles.severityBadge,
            { backgroundColor: getSeverityColor(alert.severity) }
          ]}>
            <Text style={styles.severityText}>{alert.severity}</Text>
          </View>
          {alert.acknowledged && !alert.resolved && (
            <Ionicons name="checkmark-circle" size={16} color="#4CAF50" style={styles.statusIcon} />
          )}
          {alert.resolved && (
            <Ionicons name="checkmark-done-circle" size={16} color="#4CAF50" style={styles.statusIcon} />
          )}
        </View>
      </View>
      
      <Text style={[styles.alertDescription, alert.resolved && styles.resolvedText]}>
        {alert.description}
      </Text>
      
      <View style={styles.alertFooter}>
        <Text style={styles.alertTime}>{getTimeAgo(alert.timestamp)}</Text>
        <View style={styles.alertActions}>
          {!alert.acknowledged && (
            <TouchableOpacity
              style={styles.actionButton}
              onPress={(e) => {
                e.stopPropagation();
                acknowledgeAlert(alert.id);
              }}
            >
              <Text style={styles.actionButtonText}>Acknowledge</Text>
            </TouchableOpacity>
          )}
          {alert.acknowledged && !alert.resolved && (
            <TouchableOpacity
              style={[styles.actionButton, styles.resolveButton]}
              onPress={(e) => {
                e.stopPropagation();
                resolveAlert(alert.id);
              }}
            >
              <Text style={styles.actionButtonText}>Resolve</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );

  const FilterButton = ({ filterType, label, count }) => (
    <TouchableOpacity
      style={[
        styles.filterButton,
        filter === filterType && styles.activeFilterButton
      ]}
      onPress={() => setFilter(filterType)}
    >
      <Text style={[
        styles.filterButtonText,
        filter === filterType && styles.activeFilterButtonText
      ]}>
        {label} ({count})
      </Text>
    </TouchableOpacity>
  );

  const criticalCount = alerts.filter(a => a.severity === 'critical').length;
  const warningCount = alerts.filter(a => a.severity === 'warning').length;
  const infoCount = alerts.filter(a => a.severity === 'info').length;

  return (
    <View style={styles.container}>
      {/* Alert Summary */}
      <View style={styles.summaryContainer}>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryNumber}>{alerts.length}</Text>
          <Text style={styles.summaryLabel}>Total Alerts</Text>
        </View>
        <View style={styles.summaryCard}>
          <Text style={[styles.summaryNumber, { color: '#F44336' }]}>{criticalCount}</Text>
          <Text style={styles.summaryLabel}>Critical</Text>
        </View>
        <View style={styles.summaryCard}>
          <Text style={[styles.summaryNumber, { color: '#FF9800' }]}>{warningCount}</Text>
          <Text style={styles.summaryLabel}>Warning</Text>
        </View>
        <View style={styles.summaryCard}>
          <Text style={[styles.summaryNumber, { color: '#2196F3' }]}>{infoCount}</Text>
          <Text style={styles.summaryLabel}>Info</Text>
        </View>
      </View>

      {/* Filter Buttons */}
      <View style={styles.filterContainer}>
        <FilterButton filterType="all" label="All" count={alerts.length} />
        <FilterButton filterType="critical" label="Critical" count={criticalCount} />
        <FilterButton filterType="warning" label="Warning" count={warningCount} />
        <FilterButton filterType="info" label="Info" count={infoCount} />
      </View>

      {/* Alerts List */}
      <FlatList
        data={filteredAlerts}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <AlertCard alert={item} />}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        contentContainerStyle={styles.listContainer}
        showsVerticalScrollIndicator={false}
      />

      {/* Alert Detail Modal */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={modalVisible}
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            {selectedAlert && (
              <>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>{selectedAlert.type}</Text>
                  <TouchableOpacity onPress={() => setModalVisible(false)}>
                    <Ionicons name="close" size={24} color="#666" />
                  </TouchableOpacity>
                </View>

                <View style={styles.modalBody}>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Severity:</Text>
                    <View style={[
                      styles.severityBadge,
                      { backgroundColor: getSeverityColor(selectedAlert.severity) }
                    ]}>
                      <Text style={styles.severityText}>{selectedAlert.severity}</Text>
                    </View>
                  </View>
                  
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Device:</Text>
                    <Text style={styles.detailValue}>{selectedAlert.device}</Text>
                  </View>
                  
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Location:</Text>
                    <Text style={styles.detailValue}>{selectedAlert.location}</Text>
                  </View>
                  
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Time:</Text>
                    <Text style={styles.detailValue}>
                      {selectedAlert.timestamp.toLocaleString()}
                    </Text>
                  </View>

                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Description:</Text>
                    <Text style={styles.detailValue}>{selectedAlert.description}</Text>
                  </View>

                  {Object.keys(selectedAlert.details).length > 0 && (
                    <View style={styles.additionalDetails}>
                      <Text style={styles.detailsTitle}>Additional Details:</Text>
                      {Object.entries(selectedAlert.details).map(([key, value]) => (
                        <View key={key} style={styles.detailRow}>
                          <Text style={styles.detailLabel}>{key}:</Text>
                          <Text style={styles.detailValue}>{value}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>

                <View style={styles.modalActions}>
                  {!selectedAlert.acknowledged && (
                    <TouchableOpacity 
                      style={[styles.modalActionButton, styles.acknowledgeButton]}
                      onPress={() => {
                        acknowledgeAlert(selectedAlert.id);
                        setModalVisible(false);
                      }}
                    >
                      <Ionicons name="checkmark" size={20} color="#fff" />
                      <Text style={styles.modalActionText}>Acknowledge</Text>
                    </TouchableOpacity>
                  )}
                  
                  {selectedAlert.acknowledged && !selectedAlert.resolved && (
                    <TouchableOpacity 
                      style={[styles.modalActionButton, styles.resolveButton]}
                      onPress={() => {
                        resolveAlert(selectedAlert.id);
                        setModalVisible(false);
                      }}
                    >
                      <Ionicons name="checkmark-done" size={20} color="#fff" />
                      <Text style={styles.modalActionText}>Resolve</Text>
                    </TouchableOpacity>
                  )}
                  
                  <TouchableOpacity 
                    style={[styles.modalActionButton, styles.deleteButton]}
                    onPress={() => deleteAlert(selectedAlert.id)}
                  >
                    <Ionicons name="trash" size={20} color="#fff" />
                    <Text style={styles.modalActionText}>Delete</Text>
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
  summaryContainer: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    margin: 15,
    borderRadius: 12,
    padding: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  summaryCard: {
    flex: 1,
    alignItems: 'center',
  },
  summaryNumber: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#333',
  },
  summaryLabel: {
    fontSize: 12,
    color: '#666',
    marginTop: 4,
  },
  filterContainer: {
    flexDirection: 'row',
    paddingHorizontal: 15,
    marginBottom: 15,
  },
  filterButton: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 10,
    marginHorizontal: 2,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  activeFilterButton: {
    backgroundColor: '#007AFF',
    borderColor: '#007AFF',
  },
  filterButtonText: {
    fontSize: 12,
    color: '#666',
    fontWeight: '500',
  },
  activeFilterButtonText: {
    color: '#fff',
  },
  listContainer: {
    paddingHorizontal: 15,
    paddingBottom: 20,
  },
  alertCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 15,
    marginBottom: 10,
    borderLeftWidth: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  resolvedAlert: {
    opacity: 0.6,
  },
  alertHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  alertIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#f0f8ff',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  alertInfo: {
    flex: 1,
  },
  alertType: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#333',
  },
  alertDevice: {
    fontSize: 14,
    color: '#666',
    marginTop: 2,
  },
  resolvedText: {
    textDecorationLine: 'line-through',
  },
  alertStatus: {
    alignItems: 'flex-end',
  },
  severityBadge: {
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginBottom: 4,
  },
  severityText: {
    fontSize: 10,
    color: '#fff',
    fontWeight: 'bold',
    textTransform: 'uppercase',
  },
  statusIcon: {
    marginTop: 2,
  },
  alertDescription: {
    fontSize: 14,
    color: '#666',
    marginBottom: 10,
  },
  alertFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  alertTime: {
    fontSize: 12,
    color: '#999',
  },
  alertActions: {
    flexDirection: 'row',
  },
  actionButton: {
    backgroundColor: '#007AFF',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginLeft: 8,
  },
  resolveButton: {
    backgroundColor: '#4CAF50',
  },
  actionButtonText: {
    fontSize: 12,
    color: '#fff',
    fontWeight: '500',
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
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  detailLabel: {
    fontSize: 16,
    color: '#666',
    fontWeight: '500',
  },
  detailValue: {
    fontSize: 16,
    color: '#333',
    flex: 1,
    textAlign: 'right',
  },
  additionalDetails: {
    marginTop: 15,
    padding: 15,
    backgroundColor: '#f8f9fa',
    borderRadius: 8,
  },
  detailsTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 10,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  modalActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 15,
    paddingVertical: 10,
    borderRadius: 8,
    minWidth: 100,
    justifyContent: 'center',
  },
  acknowledgeButton: {
    backgroundColor: '#007AFF',
  },
  deleteButton: {
    backgroundColor: '#F44336',
  },
  modalActionText: {
    color: '#fff',
    marginLeft: 5,
    fontSize: 14,
    fontWeight: '500',
  },
});


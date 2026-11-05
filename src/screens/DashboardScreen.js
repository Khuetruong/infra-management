import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

const { width } = Dimensions.get('window');

export default function DashboardScreen({ navigation, route }) {
  const [refreshing, setRefreshing] = useState(false);
  const [dashboardData, setDashboardData] = useState({
    totalDevices: 0,
    onlineDevices: 0,
    alerts: 0,
    networkHealth: 0,
    cpuUsage: 0,
    memoryUsage: 0,
    diskUsage: 0,
    networkTraffic: 0,
  });

  const userSubscription = route?.params?.userSubscription || 'basic';

  useEffect(() => {
    loadDashboardData();
  }, []);

  const loadDashboardData = async () => {
    try {
      // Simulate API call
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Generate mock data based on subscription level
      const mockData = generateMockData(userSubscription);
      setDashboardData(mockData);
    } catch (error) {
      console.error('Error loading dashboard data:', error);
    }
  };

  const generateMockData = (subscription) => {
    const baseData = {
      basic: { maxDevices: 10, features: 1 },
      professional: { maxDevices: 100, features: 3 },
      enterprise: { maxDevices: 1000, features: 5 },
      government: { maxDevices: 10000, features: 7 },
    };

    const config = baseData[subscription] || baseData.basic;
    
    return {
      totalDevices: Math.floor(Math.random() * config.maxDevices * 0.8) + 5,
      onlineDevices: Math.floor(Math.random() * config.maxDevices * 0.6) + 3,
      alerts: Math.floor(Math.random() * 10) + 1,
      networkHealth: Math.floor(Math.random() * 30) + 70,
      cpuUsage: Math.floor(Math.random() * 40) + 30,
      memoryUsage: Math.floor(Math.random() * 50) + 25,
      diskUsage: Math.floor(Math.random() * 60) + 20,
      networkTraffic: Math.floor(Math.random() * 100) + 50,
    };
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await loadDashboardData();
    setRefreshing(false);
  };

  const getSubscriptionColor = () => {
    const colors = {
      basic: ['#4CAF50', '#45a049'],
      professional: ['#2196F3', '#1976D2'],
      enterprise: ['#FF9800', '#F57C00'],
      government: ['#9C27B0', '#7B1FA2'],
    };
    return colors[userSubscription] || colors.basic;
  };

  const getHealthColor = (value) => {
    if (value >= 80) return '#4CAF50';
    if (value >= 60) return '#FF9800';
    return '#F44336';
  };

  const StatCard = ({ title, value, icon, color, suffix = '' }) => (
    <View style={[styles.statCard, { borderLeftColor: color }]}>
      <View style={styles.statHeader}>
        <Ionicons name={icon} size={24} color={color} />
        <Text style={styles.statTitle}>{title}</Text>
      </View>
      <Text style={[styles.statValue, { color }]}>
        {value}{suffix}
      </Text>
    </View>
  );

  const MetricCard = ({ title, value, icon, maxValue = 100 }) => {
    const percentage = (value / maxValue) * 100;
    const color = getHealthColor(percentage);
    
    return (
      <View style={styles.metricCard}>
        <View style={styles.metricHeader}>
          <Ionicons name={icon} size={20} color={color} />
          <Text style={styles.metricTitle}>{title}</Text>
        </View>
        <Text style={[styles.metricValue, { color }]}>{value}%</Text>
        <View style={styles.progressBar}>
          <View 
            style={[
              styles.progressFill, 
              { width: `${percentage}%`, backgroundColor: color }
            ]} 
          />
        </View>
      </View>
    );
  };

  return (
    <ScrollView 
      style={styles.container}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      {/* Header */}
      <LinearGradient
        colors={getSubscriptionColor()}
        style={styles.header}
      >
        <View style={styles.headerContent}>
          <Text style={styles.welcomeText}>Welcome back!</Text>
          <Text style={styles.subscriptionText}>
            {userSubscription.charAt(0).toUpperCase() + userSubscription.slice(1)} Plan
          </Text>
        </View>
        <TouchableOpacity 
          style={styles.upgradeButton}
          onPress={() => navigation.navigate('Subscription')}
        >
          <Ionicons name="arrow-up-circle-outline" size={24} color="#fff" />
        </TouchableOpacity>
      </LinearGradient>

      {/* Quick Stats */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>System Overview</Text>
        <View style={styles.statsGrid}>
          <StatCard
            title="Total Devices"
            value={dashboardData.totalDevices}
            icon="hardware-chip"
            color="#2196F3"
          />
          <StatCard
            title="Online Devices"
            value={dashboardData.onlineDevices}
            icon="checkmark-circle"
            color="#4CAF50"
          />
          <StatCard
            title="Active Alerts"
            value={dashboardData.alerts}
            icon="warning"
            color="#FF9800"
          />
          <StatCard
            title="Network Health"
            value={dashboardData.networkHealth}
            icon="wifi"
            color={getHealthColor(dashboardData.networkHealth)}
            suffix="%"
          />
        </View>
      </View>

      {/* Performance Metrics */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Performance Metrics</Text>
        <View style={styles.metricsGrid}>
          <MetricCard
            title="CPU Usage"
            value={dashboardData.cpuUsage}
            icon="speedometer"
          />
          <MetricCard
            title="Memory Usage"
            value={dashboardData.memoryUsage}
            icon="layers"
          />
          <MetricCard
            title="Disk Usage"
            value={dashboardData.diskUsage}
            icon="server"
          />
          <MetricCard
            title="Network Traffic"
            value={dashboardData.networkTraffic}
            icon="analytics"
          />
        </View>
      </View>

      {/* Quick Actions */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Quick Actions</Text>
        <View style={styles.actionsGrid}>
          <TouchableOpacity 
            style={styles.actionCard}
            onPress={() => navigation.navigate('Devices')}
          >
            <Ionicons name="hardware-chip" size={32} color="#2196F3" />
            <Text style={styles.actionText}>Manage Devices</Text>
          </TouchableOpacity>
          
          <TouchableOpacity 
            style={styles.actionCard}
            onPress={() => navigation.navigate('Network')}
          >
            <Ionicons name="wifi" size={32} color="#4CAF50" />
            <Text style={styles.actionText}>Network Scan</Text>
          </TouchableOpacity>
          
          <TouchableOpacity 
            style={styles.actionCard}
            onPress={() => navigation.navigate('Alerts')}
          >
            <Ionicons name="notifications" size={32} color="#FF9800" />
            <Text style={styles.actionText}>View Alerts</Text>
          </TouchableOpacity>
          
          <TouchableOpacity 
            style={styles.actionCard}
            onPress={() => navigation.navigate('Settings')}
          >
            <Ionicons name="settings" size={32} color="#9C27B0" />
            <Text style={styles.actionText}>Settings</Text>
          </TouchableOpacity>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  header: {
    padding: 20,
    paddingTop: 40,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerContent: {
    flex: 1,
  },
  welcomeText: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
  },
  subscriptionText: {
    fontSize: 16,
    color: 'rgba(255, 255, 255, 0.8)',
    marginTop: 4,
  },
  upgradeButton: {
    padding: 8,
  },
  section: {
    padding: 20,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 15,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  statCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 15,
    width: (width - 50) / 2,
    marginBottom: 10,
    borderLeftWidth: 4,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  statHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  statTitle: {
    fontSize: 14,
    color: '#666',
    marginLeft: 8,
    flex: 1,
  },
  statValue: {
    fontSize: 24,
    fontWeight: 'bold',
  },
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  metricCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 15,
    width: (width - 50) / 2,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  metricHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  metricTitle: {
    fontSize: 14,
    color: '#666',
    marginLeft: 8,
    flex: 1,
  },
  metricValue: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  progressBar: {
    height: 6,
    backgroundColor: '#e0e0e0',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
  },
  actionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  actionCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    width: (width - 50) / 2,
    marginBottom: 10,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  actionText: {
    fontSize: 14,
    color: '#333',
    marginTop: 8,
    textAlign: 'center',
  },
});


import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

const { width } = Dimensions.get('window');

export default function SubscriptionScreen({ navigation, onLogin }) {
  const [selectedPlan, setSelectedPlan] = useState('professional');

  const subscriptionPlans = [
    {
      id: 'basic',
      name: 'Basic',
      price: '$29',
      period: '/month',
      color: ['#4CAF50', '#45a049'],
      features: [
        'Up to 10 devices',
        '1 monitoring site',
        'Basic alerts',
        'Email support',
        'Mobile app access',
        'Basic reporting',
      ],
      limitations: [
        'Limited to home networks',
        'Basic monitoring only',
        'No AI insights',
      ],
    },
    {
      id: 'professional',
      name: 'Professional',
      price: '$99',
      period: '/month',
      color: ['#2196F3', '#1976D2'],
      popular: true,
      features: [
        'Up to 100 devices',
        '5 monitoring sites',
        'Advanced alerts',
        'Priority support',
        'Mobile & web access',
        'Advanced reporting',
        'AI insights',
        'Network topology',
        'Performance analytics',
      ],
      limitations: [
        'Limited enterprise features',
      ],
    },
    {
      id: 'enterprise',
      name: 'Enterprise',
      price: '$299',
      period: '/month',
      color: ['#FF9800', '#F57C00'],
      features: [
        'Unlimited devices',
        'Unlimited sites',
        'Real-time alerts',
        '24/7 phone support',
        'Full platform access',
        'Custom reporting',
        'Advanced AI analytics',
        'Multi-site management',
        'API access',
        'Custom integrations',
        'Dedicated account manager',
      ],
      limitations: [],
    },
    {
      id: 'government',
      name: 'Government',
      price: '$999',
      period: '/month',
      color: ['#9C27B0', '#7B1FA2'],
      features: [
        'All Enterprise features',
        'Government-grade security',
        'AI behavior analysis',
        'Threat detection',
        'Criminal activity monitoring',
        'Emergency response integration',
        'Compliance reporting',
        'Audit trails',
        'Multi-level access control',
        'Classified data handling',
        'On-premise deployment',
      ],
      limitations: [],
      restricted: true,
    },
  ];

  const handleSelectPlan = (planId) => {
    setSelectedPlan(planId);
  };

  const handleSubscribe = () => {
    const plan = subscriptionPlans.find(p => p.id === selectedPlan);
    
    if (plan.restricted) {
      Alert.alert(
        'Government Plan',
        'This plan requires government authorization. Please contact our sales team for verification.',
        [
          { text: 'Cancel' },
          { text: 'Contact Sales', onPress: () => Alert.alert('Contact', 'sales@inframonitor.com') }
        ]
      );
      return;
    }

    Alert.alert(
      'Subscribe',
      `Subscribe to ${plan.name} plan for ${plan.price}${plan.period}?`,
      [
        { text: 'Cancel' },
        { 
          text: 'Subscribe', 
          onPress: () => {
            Alert.alert('Success', `Subscribed to ${plan.name} plan!`);
            if (onLogin) {
              onLogin(selectedPlan);
            } else {
              navigation.goBack();
            }
          }
        }
      ]
    );
  };

  const PlanCard = ({ plan }) => (
    <TouchableOpacity
      style={[
        styles.planCard,
        selectedPlan === plan.id && styles.selectedPlan,
        plan.restricted && styles.restrictedPlan,
      ]}
      onPress={() => handleSelectPlan(plan.id)}
    >
      <LinearGradient
        colors={selectedPlan === plan.id ? plan.color : ['#fff', '#fff']}
        style={styles.planHeader}
      >
        {plan.popular && (
          <View style={styles.popularBadge}>
            <Text style={styles.popularText}>MOST POPULAR</Text>
          </View>
        )}
        {plan.restricted && (
          <View style={styles.restrictedBadge}>
            <Ionicons name="shield-checkmark" size={16} color="#fff" />
            <Text style={styles.restrictedText}>RESTRICTED</Text>
          </View>
        )}
        
        <Text style={[
          styles.planName,
          selectedPlan === plan.id && styles.selectedPlanName
        ]}>
          {plan.name}
        </Text>
        
        <View style={styles.priceContainer}>
          <Text style={[
            styles.planPrice,
            selectedPlan === plan.id && styles.selectedPlanPrice
          ]}>
            {plan.price}
          </Text>
          <Text style={[
            styles.planPeriod,
            selectedPlan === plan.id && styles.selectedPlanPeriod
          ]}>
            {plan.period}
          </Text>
        </View>
      </LinearGradient>

      <View style={styles.planBody}>
        <View style={styles.featuresContainer}>
          <Text style={styles.featuresTitle}>Features:</Text>
          {plan.features.map((feature, index) => (
            <View key={index} style={styles.featureItem}>
              <Ionicons name="checkmark-circle" size={16} color="#4CAF50" />
              <Text style={styles.featureText}>{feature}</Text>
            </View>
          ))}
        </View>

        {plan.limitations.length > 0 && (
          <View style={styles.limitationsContainer}>
            <Text style={styles.limitationsTitle}>Limitations:</Text>
            {plan.limitations.map((limitation, index) => (
              <View key={index} style={styles.limitationItem}>
                <Ionicons name="close-circle" size={16} color="#F44336" />
                <Text style={styles.limitationText}>{limitation}</Text>
              </View>
            ))}
          </View>
        )}

        {selectedPlan === plan.id && (
          <View style={styles.selectedIndicator}>
            <Ionicons name="checkmark-circle" size={24} color="#4CAF50" />
            <Text style={styles.selectedText}>Selected</Text>
          </View>
        )}
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scrollContainer} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Choose Your Plan</Text>
          <Text style={styles.headerSubtitle}>
            Select the perfect monitoring solution for your needs
          </Text>
        </View>

        {/* Plans */}
        <View style={styles.plansContainer}>
          {subscriptionPlans.map((plan) => (
            <PlanCard key={plan.id} plan={plan} />
          ))}
        </View>

        {/* Features Comparison */}
        <View style={styles.comparisonContainer}>
          <Text style={styles.comparisonTitle}>Why Choose Professional?</Text>
          <View style={styles.comparisonGrid}>
            <View style={styles.comparisonItem}>
              <Ionicons name="analytics" size={32} color="#2196F3" />
              <Text style={styles.comparisonItemTitle}>AI Insights</Text>
              <Text style={styles.comparisonItemText}>
                Get intelligent recommendations and predictive analytics
              </Text>
            </View>
            
            <View style={styles.comparisonItem}>
              <Ionicons name="shield-checkmark" size={32} color="#4CAF50" />
              <Text style={styles.comparisonItemTitle}>Advanced Security</Text>
              <Text style={styles.comparisonItemText}>
                Enhanced threat detection and security monitoring
              </Text>
            </View>
            
            <View style={styles.comparisonItem}>
              <Ionicons name="people" size={32} color="#FF9800" />
              <Text style={styles.comparisonItemTitle}>Priority Support</Text>
              <Text style={styles.comparisonItemText}>
                Get help when you need it with priority support
              </Text>
            </View>
            
            <View style={styles.comparisonItem}>
              <Ionicons name="trending-up" size={32} color="#9C27B0" />
              <Text style={styles.comparisonItemTitle}>Scalability</Text>
              <Text style={styles.comparisonItemText}>
                Grow your monitoring as your business expands
              </Text>
            </View>
          </View>
        </View>

        {/* Testimonials */}
        <View style={styles.testimonialsContainer}>
          <Text style={styles.testimonialsTitle}>What Our Customers Say</Text>
          <View style={styles.testimonial}>
            <Text style={styles.testimonialText}>
              "Infrastructure Monitor has transformed how we manage our network. 
              The AI insights are incredibly valuable."
            </Text>
            <Text style={styles.testimonialAuthor}>- Sarah Johnson, IT Director</Text>
          </View>
          
          <View style={styles.testimonial}>
            <Text style={styles.testimonialText}>
              "The government plan provides the security and compliance we need 
              for our critical infrastructure."
            </Text>
            <Text style={styles.testimonialAuthor}>- Michael Chen, Security Manager</Text>
          </View>
        </View>
      </ScrollView>

      {/* Subscribe Button */}
      <View style={styles.subscribeContainer}>
        <TouchableOpacity style={styles.subscribeButton} onPress={handleSubscribe}>
          <LinearGradient
            colors={subscriptionPlans.find(p => p.id === selectedPlan)?.color || ['#007AFF', '#0051D5']}
            style={styles.subscribeButtonGradient}
          >
            <Text style={styles.subscribeButtonText}>
              Subscribe to {subscriptionPlans.find(p => p.id === selectedPlan)?.name}
            </Text>
            <Ionicons name="arrow-forward" size={20} color="#fff" />
          </LinearGradient>
        </TouchableOpacity>
        
        <Text style={styles.subscribeNote}>
          30-day free trial • Cancel anytime • No setup fees
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  scrollContainer: {
    flex: 1,
  },
  header: {
    padding: 20,
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#333',
    textAlign: 'center',
  },
  headerSubtitle: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    marginTop: 8,
  },
  plansContainer: {
    padding: 15,
  },
  planCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    marginBottom: 15,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 5,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  selectedPlan: {
    borderColor: '#007AFF',
    transform: [{ scale: 1.02 }],
  },
  restrictedPlan: {
    borderColor: '#9C27B0',
  },
  planHeader: {
    padding: 20,
    position: 'relative',
  },
  popularBadge: {
    position: 'absolute',
    top: 0,
    right: 0,
    backgroundColor: '#FF9800',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomLeftRadius: 8,
  },
  popularText: {
    fontSize: 10,
    color: '#fff',
    fontWeight: 'bold',
  },
  restrictedBadge: {
    position: 'absolute',
    top: 0,
    right: 0,
    backgroundColor: '#9C27B0',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomLeftRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  restrictedText: {
    fontSize: 10,
    color: '#fff',
    fontWeight: 'bold',
    marginLeft: 4,
  },
  planName: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 8,
  },
  selectedPlanName: {
    color: '#fff',
  },
  priceContainer: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  planPrice: {
    fontSize: 36,
    fontWeight: 'bold',
    color: '#333',
  },
  selectedPlanPrice: {
    color: '#fff',
  },
  planPeriod: {
    fontSize: 16,
    color: '#666',
    marginLeft: 4,
  },
  selectedPlanPeriod: {
    color: 'rgba(255, 255, 255, 0.8)',
  },
  planBody: {
    padding: 20,
  },
  featuresContainer: {
    marginBottom: 15,
  },
  featuresTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 10,
  },
  featureItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  featureText: {
    fontSize: 14,
    color: '#333',
    marginLeft: 8,
    flex: 1,
  },
  limitationsContainer: {
    marginBottom: 15,
  },
  limitationsTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#F44336',
    marginBottom: 10,
  },
  limitationItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  limitationText: {
    fontSize: 14,
    color: '#666',
    marginLeft: 8,
    flex: 1,
  },
  selectedIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
    padding: 10,
    backgroundColor: '#f0f8ff',
    borderRadius: 8,
  },
  selectedText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#4CAF50',
    marginLeft: 8,
  },
  comparisonContainer: {
    backgroundColor: '#fff',
    margin: 15,
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  comparisonTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#333',
    textAlign: 'center',
    marginBottom: 20,
  },
  comparisonGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  comparisonItem: {
    width: (width - 70) / 2,
    alignItems: 'center',
    marginBottom: 20,
  },
  comparisonItemTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#333',
    marginTop: 8,
    textAlign: 'center',
  },
  comparisonItemText: {
    fontSize: 12,
    color: '#666',
    textAlign: 'center',
    marginTop: 4,
  },
  testimonialsContainer: {
    backgroundColor: '#fff',
    margin: 15,
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  testimonialsTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#333',
    textAlign: 'center',
    marginBottom: 20,
  },
  testimonial: {
    marginBottom: 15,
    padding: 15,
    backgroundColor: '#f8f9fa',
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: '#007AFF',
  },
  testimonialText: {
    fontSize: 14,
    color: '#333',
    fontStyle: 'italic',
    lineHeight: 20,
  },
  testimonialAuthor: {
    fontSize: 12,
    color: '#666',
    marginTop: 8,
    textAlign: 'right',
  },
  subscribeContainer: {
    backgroundColor: '#fff',
    padding: 20,
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
  },
  subscribeButton: {
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 10,
  },
  subscribeButtonGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  subscribeButtonText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#fff',
    marginRight: 8,
  },
  subscribeNote: {
    fontSize: 12,
    color: '#666',
    textAlign: 'center',
  },
});


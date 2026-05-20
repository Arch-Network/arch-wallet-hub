import { Tabs } from "expo-router";
import { View, StyleSheet } from "react-native";
import { Colors, Fonts } from "../../constants/Theme";
import {
  HomeIcon,
  SendIcon,
  ReceiveIcon,
  HistoryIcon,
  SettingsIcon,
} from "../../src/components/Icons";

function TabIcon({ name, color }: { name: string; color: string }) {
  const iconMap: Record<string, React.ReactNode> = {
    Home: <HomeIcon size={20} color={color} />,
    Send: <SendIcon size={20} color={color} />,
    Receive: <ReceiveIcon size={20} color={color} />,
    History: <HistoryIcon size={20} color={color} />,
    Settings: <SettingsIcon size={20} color={color} />,
  };
  return (
    <View style={styles.iconWrap}>
      {iconMap[name] ?? null}
    </View>
  );
}

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: Colors.accent,
        tabBarInactiveTintColor: Colors.textMuted,
        tabBarStyle: {
          backgroundColor: Colors.bgSecondary,
          borderTopColor: Colors.borderPrimary,
          borderTopWidth: 1,
          paddingBottom: 8,
          paddingTop: 6,
          height: 64,
        },
        tabBarLabelStyle: {
          fontSize: 10,
          fontFamily: Fonts.bodyMedium,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color }) => <TabIcon name="Home" color={color} />,
        }}
      />
      <Tabs.Screen
        name="send"
        options={{
          title: "Send",
          tabBarIcon: ({ color }) => <TabIcon name="Send" color={color} />,
        }}
      />
      <Tabs.Screen
        name="receive"
        options={{
          title: "Receive",
          tabBarIcon: ({ color }) => <TabIcon name="Receive" color={color} />,
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: "History",
          tabBarIcon: ({ color }) => <TabIcon name="History" color={color} />,
        }}
      />
      <Tabs.Screen
        name="browser"
        options={{
          href: null,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color }) => <TabIcon name="Settings" color={color} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  iconWrap: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
});

import { View, Text, StyleSheet, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { Colors } from "../constants/Theme";

export default function NotFound() {
  const router = useRouter();

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Page not found</Text>
      <Pressable onPress={() => router.replace("/(tabs)")} style={styles.btn}>
        <Text style={styles.btnText}>Go Home</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: Colors.bgPrimary,
    padding: 24,
  },
  title: {
    color: Colors.textPrimary,
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 16,
  },
  btn: {
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.accent,
  },
  btnText: {
    color: Colors.accent,
    fontSize: 14,
    fontWeight: "600",
  },
});

import { Pressable, StyleSheet, Text, ViewStyle } from 'react-native';

export const C = {
  bg: '#fbf8f1',
  paper: '#f6f0e2',
  ink: '#2b2a27',
  soft: '#8a8578',
  read: '#1f5fbf',
  cur: '#ffe27a',
  red: '#d81e1e',
  bar: '#efe8d6',
  line: '#d9cfb8',
};

type BtnProps = {
  label: string;
  onPress: () => void;
  primary?: boolean;
  live?: boolean;
  warn?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
};
export function Btn({ label, onPress, primary, live, warn, disabled, style }: BtnProps) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.btn,
        primary && s.pri,
        live && s.live,
        warn && s.warn,
        disabled && { opacity: 0.4 },
        pressed && { opacity: 0.7 },
        style,
      ]}
    >
      <Text style={[s.t, (primary || live) && { color: '#fff' }]} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  btn: {
    minHeight: 46,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: C.ink,
    backgroundColor: '#fff',
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pri: { backgroundColor: C.ink },
  live: { backgroundColor: C.read, borderColor: C.read },
  warn: { backgroundColor: C.cur, borderColor: '#b8941a' },
  t: { fontSize: 16, fontWeight: '700', color: C.ink, textAlign: 'center' },
});

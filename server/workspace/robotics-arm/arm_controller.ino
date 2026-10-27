// Robotics Arm: arm servos + gripper motor (L298N driver), Arduino Uno.
#include <Servo.h>

const int SHOULDER_PIN = 9;
const int ELBOW_PIN = 10;
const int GRIPPER_EN = 7;    // L298N ENA (speed)
const int GRIPPER_IN1 = 4;
const int GRIPPER_IN2 = 5;
const int GRIPPER_SPEED = 140;  // 0-255

Servo shoulder;
Servo elbow;

void setup() {
  shoulder.attach(SHOULDER_PIN);
  elbow.attach(ELBOW_PIN);
  pinMode(GRIPPER_IN1, OUTPUT);
  pinMode(GRIPPER_IN2, OUTPUT);
  pinMode(GRIPPER_EN, OUTPUT);
  Serial.begin(9600);
}

void closeGripper() {
  digitalWrite(GRIPPER_IN1, HIGH);
  digitalWrite(GRIPPER_IN2, LOW);
  analogWrite(GRIPPER_EN, GRIPPER_SPEED);  // speed control
  delay(600);
  analogWrite(GRIPPER_EN, 0);
}

void openGripper() {
  digitalWrite(GRIPPER_IN1, LOW);
  digitalWrite(GRIPPER_IN2, HIGH);
  analogWrite(GRIPPER_EN, GRIPPER_SPEED);
  delay(600);
  analogWrite(GRIPPER_EN, 0);
}

void loop() {
  shoulder.write(40);
  elbow.write(120);
  delay(800);
  closeGripper();
  shoulder.write(110);
  delay(800);
  openGripper();
  delay(1000);
}

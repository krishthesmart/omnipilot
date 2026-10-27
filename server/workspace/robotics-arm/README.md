# Robotics Arm

An Arduino Uno robot arm that picks up foam blocks and drops them in a bin.
Two servos move the arm; a small DC motor (through an L298N driver) opens and closes the gripper.

Known problem: the gripper motor either runs at full speed or doesn't move at all;
changing `GRIPPER_SPEED` makes no difference.

Sample project for OmniPilot's demo ("find my robotics project and help me fix the motor problem").

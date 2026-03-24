import Attendance from '../models/Attendance.js';

export const getAttendances = async (req, res) => {
  try {
    const attendances = await Attendance.find({}).populate('employeeId', 'name email');
    res.json(attendances);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const markAttendance = async (req, res) => {
  const { employeeId, date, status, checkInTime, checkOutTime } = req.body;

  try {
    const attendance = await Attendance.create({
      employeeId,
      date,
      status,
      checkInTime,
      checkOutTime,
    });

    res.status(201).json(attendance);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

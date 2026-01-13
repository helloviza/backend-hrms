import { Schema, model } from "mongoose";
const HolidaySchema = new Schema({
  date: String,
  name: String,
  region: String,
});
export default model("Holiday", HolidaySchema);

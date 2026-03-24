export const mockFlightSearch = {
  ResponseStatus: 1,
  Error: { ErrorCode: 0, ErrorMessage: "" },
  Response: {
    TraceId: "mock-trace-001",
    Results: [
      {
        ResultIndex: "OB1",
        IsLCC: true,
        NonRefundable: false,
        Fare: {
          BaseFare: 3500,
          Tax: 800,
          TotalFare: 4300,
          PublishedFare: 4300,
          Currency: "INR",
        },
        Segments: [[{
          Airline: { AirlineCode: "6E", AirlineName: "IndiGo", FlightNumber: "6E-2341", AirlineDescription: "" },
          Origin: { Airport: { AirportCode: "DEL", AirportName: "Indira Gandhi Intl", CityName: "New Delhi", CountryCode: "IN" }, DepTime: "2026-03-15T06:00:00" },
          Destination: { Airport: { AirportCode: "BOM", AirportName: "Chhatrapati Shivaji Intl", CityName: "Mumbai", CountryCode: "IN" }, ArrTime: "2026-03-15T08:15:00" },
          Duration: 135, GroundTime: 0,
          Baggage: "15 Kg", CabinBaggage: "7 Kg",
          CabinClass: 2, SeatsAvailable: 9,
          IsETicketEligible: true,
        }]],
      },
      {
        ResultIndex: "OB2",
        IsLCC: false,
        NonRefundable: false,
        Fare: { BaseFare: 5200, Tax: 1100, TotalFare: 6300, PublishedFare: 6300, Currency: "INR" },
        Segments: [[{
          Airline: { AirlineCode: "AI", AirlineName: "Air India", FlightNumber: "AI-864", AirlineDescription: "" },
          Origin: { Airport: { AirportCode: "DEL", AirportName: "Indira Gandhi Intl", CityName: "New Delhi", CountryCode: "IN" }, DepTime: "2026-03-15T09:30:00" },
          Destination: { Airport: { AirportCode: "BOM", AirportName: "Chhatrapati Shivaji Intl", CityName: "Mumbai", CountryCode: "IN" }, ArrTime: "2026-03-15T11:45:00" },
          Duration: 135, GroundTime: 0,
          Baggage: "25 Kg", CabinBaggage: "8 Kg",
          CabinClass: 2, SeatsAvailable: 4,
          IsETicketEligible: true,
        }]],
      },
      {
        ResultIndex: "OB3",
        IsLCC: true,
        NonRefundable: true,
        Fare: { BaseFare: 2800, Tax: 650, TotalFare: 3450, PublishedFare: 3450, Currency: "INR" },
        Segments: [[{
          Airline: { AirlineCode: "SG", AirlineName: "SpiceJet", FlightNumber: "SG-157", AirlineDescription: "" },
          Origin: { Airport: { AirportCode: "DEL", AirportName: "Indira Gandhi Intl", CityName: "New Delhi", CountryCode: "IN" }, DepTime: "2026-03-15T14:20:00" },
          Destination: { Airport: { AirportCode: "BOM", AirportName: "Chhatrapati Shivaji Intl", CityName: "Mumbai", CountryCode: "IN" }, ArrTime: "2026-03-15T16:35:00" },
          Duration: 135, GroundTime: 0,
          Baggage: "15 Kg", CabinBaggage: "7 Kg",
          CabinClass: 2, SeatsAvailable: 2,
          IsETicketEligible: true,
        }]],
      },
      {
        ResultIndex: "OB4",
        IsLCC: true,
        NonRefundable: false,
        Fare: { BaseFare: 4100, Tax: 900, TotalFare: 5000, PublishedFare: 5000, Currency: "INR" },
        Segments: [[{
          Airline: { AirlineCode: "UK", AirlineName: "Vistara", FlightNumber: "UK-985", AirlineDescription: "" },
          Origin: { Airport: { AirportCode: "DEL", AirportName: "Indira Gandhi Intl", CityName: "New Delhi", CountryCode: "IN" }, DepTime: "2026-03-15T17:45:00" },
          Destination: { Airport: { AirportCode: "BOM", AirportName: "Chhatrapati Shivaji Intl", CityName: "Mumbai", CountryCode: "IN" }, ArrTime: "2026-03-15T20:00:00" },
          Duration: 135, GroundTime: 0,
          Baggage: "20 Kg", CabinBaggage: "7 Kg",
          CabinClass: 2, SeatsAvailable: 6,
          IsETicketEligible: true,
        }]],
      },
    ]
  }
};

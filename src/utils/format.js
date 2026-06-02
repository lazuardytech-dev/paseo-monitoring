function formatNumber(value, unit = "") {
  if (value == null || Number.isNaN(Number(value))) {
    return "-";
  }

  return `${Number(value).toFixed(2)}${unit}`;
}

function formatDate(isoString) {
  if (!isoString) {
    return "-";
  }

  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleString();
}

function toStatusLabel(value) {
  if (!value) {
    return "Unknown";
  }

  return String(value)
    .split("_")
    .map((part) => {
      if (!part) {
        return part;
      }

      return part[0].toUpperCase() + part.slice(1);
    })
    .join(" ");
}

export { formatNumber, formatDate, toStatusLabel };
